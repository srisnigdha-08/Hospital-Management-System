const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

const { ALLOWED_EXT_MAP } = require('../utils/fileSecurity');

const uploadDir = path.resolve(process.cwd(), env.upload.dir);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const rawExt = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXT_MAP[rawExt] ? rawExt : '.bin';
    const unique = crypto.randomBytes(16).toString('hex');
    cb(null, `${Date.now()}-${unique}${safeExt}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mapping = ALLOWED_EXT_MAP[ext];

  if (!mapping) {
    return cb(
      ApiError.badRequest(
        `Unsupported file extension "${ext}". Allowed: ${Object.keys(ALLOWED_EXT_MAP).join(', ')}`
      )
    );
  }

  if (file.mimetype !== mapping.mime) {
    return cb(
      ApiError.badRequest(
        `File extension "${ext}" does not match provided MIME type "${file.mimetype}". Expected "${mapping.mime}".`
      )
    );
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: env.upload.maxMb * 1024 * 1024 },
});

module.exports = upload;
