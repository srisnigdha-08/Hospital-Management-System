const fs = require('fs');
const path = require('path');
const ApiError = require('./ApiError');
const logger = require('./logger');

const ALLOWED_EXT_MAP = {
  '.pdf': { mime: 'application/pdf', type: 'pdf' },
  '.png': { mime: 'image/png', type: 'png' },
  '.jpg': { mime: 'image/jpeg', type: 'jpeg' },
  '.jpeg': { mime: 'image/jpeg', type: 'jpeg' },
  '.webp': { mime: 'image/webp', type: 'webp' },
  '.txt': { mime: 'text/plain', type: 'txt' },
};

/**
 * Inspects the initial bytes of a buffer to verify magic bytes / signatures.
 * Supported clinical types: PDF, PNG, JPEG, WEBP, and safe plain text.
 */
function detectFileTypeFromBuffer(buf) {
  if (!buf || buf.length < 4) return null;

  // PDF: %PDF- (0x25 0x50 0x44 0x46 0x2D)
  if (
    buf.length >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) {
    return 'pdf';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }

  // WEBP: RIFF....WEBP (0x52 0x49 0x46 0x46 .... 0x57 0x45 0x42 0x50)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }

  // Plain text: UTF-8 / ASCII text without binary control characters or script / executable headers
  const isBinarySignature =
    (buf[0] === 0x4d && buf[1] === 0x5a) || // PE (exe/dll)
    (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) || // ELF
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04); // ZIP

  if (!isBinarySignature) {
    let hasNull = false;
    let nonPrintable = 0;
    const sampleLen = Math.min(buf.length, 512);

    for (let i = 0; i < sampleLen; i++) {
      const byte = buf[i];
      if (byte === 0x00) {
        hasNull = true;
        break;
      }
      // Allowed control chars: \t (9), \n (10), \r (13)
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
        nonPrintable++;
      }
    }

    if (!hasNull && nonPrintable / sampleLen < 0.05) {
      // Disallow HTML / XML / SVG / PHP opening tags in plain text attachments
      const sampleText = buf.slice(0, 100).toString('utf8').trim().toLowerCase();
      if (
        sampleText.startsWith('<!doctype html') ||
        sampleText.startsWith('<html') ||
        sampleText.startsWith('<?xml') ||
        sampleText.startsWith('<svg') ||
        sampleText.startsWith('<?php') ||
        sampleText.startsWith('<script')
      ) {
        return null;
      }
      return 'txt';
    }
  }

  return null;
}

/**
 * Validates file signature from disk against expected extension.
 */
async function validateFileSignature(filePath, ext) {
  const mapping = ALLOWED_EXT_MAP[ext.toLowerCase()];
  if (!mapping) {
    throw ApiError.badRequest(`Unsupported file extension: ${ext}`);
  }

  let fileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await fileHandle.read(buffer, 0, 512, 0);

    if (bytesRead === 0) {
      throw ApiError.badRequest('Uploaded file is empty');
    }

    const detected = detectFileTypeFromBuffer(buffer.subarray(0, bytesRead));
    if (detected !== mapping.type) {
      throw ApiError.badRequest(
        `File signature does not match claimed file type (${ext}). Detected: ${detected || 'unknown/unsupported'}`
      );
    }
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

/**
 * Safely removes a file from disk if it exists, without throwing unhandled exceptions.
 */
async function cleanupUploadedFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (err) {
    logger.warn(`Failed to cleanup file ${filePath}: ${err.message}`);
  }
}

/**
 * Resolves a stored file path safely within the upload directory,
 * preventing directory traversal, absolute path injection, or symlink escapes.
 */
function resolveSafeFilePath(uploadDir, storedPath) {
  if (!storedPath || typeof storedPath !== 'string') {
    throw ApiError.badRequest('Invalid file path');
  }

  // Prevent null-byte injection
  if (storedPath.includes('\0')) {
    throw ApiError.badRequest('Invalid characters in file path');
  }

  // Explicitly reject directory traversal sequences
  if (storedPath.includes('..')) {
    throw ApiError.badRequest('Directory traversal sequences are forbidden');
  }

  // Explicitly reject absolute paths
  if (path.isAbsolute(storedPath)) {
    throw ApiError.badRequest('Absolute paths are forbidden');
  }

  // Normalizing: extract filename to ensure path remains inside uploadDir
  const baseName = path.basename(storedPath);
  if (!baseName || baseName === '.' || baseName === '..') {
    throw ApiError.badRequest('Invalid attachment filename');
  }

  const resolvedUploadDir = path.resolve(uploadDir);
  const resolvedPath = path.resolve(resolvedUploadDir, baseName);

  // Ensure resolved path is strictly within the upload directory
  if (
    !resolvedPath.startsWith(resolvedUploadDir + path.sep) &&
    resolvedPath !== resolvedUploadDir
  ) {
    throw ApiError.forbidden('Access to file outside upload directory is forbidden');
  }

  // If file exists, check realpath to protect against symlink traversal
  if (fs.existsSync(resolvedPath)) {
    const real = fs.realpathSync(resolvedPath);
    if (!real.startsWith(resolvedUploadDir + path.sep) && real !== resolvedUploadDir) {
      throw ApiError.forbidden('Symbolic link outside upload directory is forbidden');
    }
    return real;
  }

  return resolvedPath;
}

module.exports = {
  ALLOWED_EXT_MAP,
  detectFileTypeFromBuffer,
  validateFileSignature,
  cleanupUploadedFile,
  resolveSafeFilePath,
};
