const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Transaction, Op } = require('sequelize');
const env = require('../config/env');
const { sequelize, User, RefreshToken } = require('../models');
const auditLog = require('./auditLog.service');
const logger = require('../utils/logger');

function signAccessToken(user) {
  if (!Number.isInteger(user.tokenVersion) || user.tokenVersion < 0) {
    throw new TypeError('A valid user token version is required to issue an access token');
  }
  return jwt.sign(
    { sub: user.userId, role: user.roleId, email: user.email, tokenVersion: user.tokenVersion, jti: crypto.randomUUID() },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpiresIn, algorithm: 'HS256' }
  );
}

function signRefreshToken(user, familyId) {
  return jwt.sign(
    { sub: user.userId, familyId, jti: crypto.randomUUID() },
    env.jwt.refreshSecret,
    {
      expiresIn: env.jwt.refreshExpiresIn,
      algorithm: 'HS256',
    }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function msFromExpiresIn(expiresIn) {
  // supports "15m", "7d", "1h" style values used by jsonwebtoken
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!match) return 15 * 60 * 1000;
  const [, amount, unit] = match;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Number(amount) * multipliers[unit];
}

/** Issues a new access + refresh token pair and persists the hashed refresh token with family tracking. */
async function issueTokenPair(user, ip, familyId = null, transaction = null) {
  const effectiveFamilyId = familyId || crypto.randomUUID();
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user, effectiveFamilyId);

  const tokenRecord = await RefreshToken.create(
    {
      userId: user.userId,
      familyId: effectiveFamilyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + msFromExpiresIn(env.jwt.refreshExpiresIn)),
      createdByIp: ip,
    },
    transaction ? { transaction } : undefined
  );

  return {
    accessToken,
    refreshToken,
    familyId: effectiveFamilyId,
    tokenId: tokenRecord.tokenId,
  };
}

/**
 * Validates a refresh token against the DB and rotates it within an atomic managed transaction.
 * 
 * Cryptographic Pre-flight:
 * - Verifies HS256 algorithm and signature. Rejects expired, tampered, or unsupported algorithms without DB mutations.
 * 
 * Transactional State Evaluation (with row-level lock):
 * - If token is active (revokedAt is null): atomically marks revoked, inserts successor, links replacedByTokenId.
 * - If token is already revoked: DETECTS REPLAY! Atomically commits family-wide revocation.
 * - Managed transaction returns outcome to guarantee family revocation commits BEFORE returning 401.
 */
async function rotateRefreshToken(oldToken, ip) {
  if (!oldToken || typeof oldToken !== 'string') {
    return null;
  }

  // 1. Cryptographic validation prior to opening database transaction
  let payload;
  try {
    payload = jwt.verify(oldToken, env.jwt.refreshSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }

  if (!payload || !payload.sub) {
    return null;
  }

  const tokenHash = hashToken(oldToken);

  // 2. Managed transaction with row-level locking
  const outcome = await sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
    async (t) => {
      const stored = await RefreshToken.findOne({
        where: { tokenHash, userId: payload.sub },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!stored) {
        return { status: 'NOT_FOUND' };
      }

      // Check database expiration
      if (new Date() >= new Date(stored.expiresAt)) {
        return { status: 'EXPIRED' };
      }

      // Validate family claim consistency:
      // If payload has familyId, it MUST match stored.familyId.
      if (payload.familyId && payload.familyId !== stored.familyId) {
        return { status: 'FAMILY_MISMATCH' };
      }

      const effectiveFamilyId = stored.familyId;
      if (!effectiveFamilyId) {
        return { status: 'INVALID_FAMILY' };
      }

      // Check if user is active
      const user = await User.findByPk(stored.userId, { transaction: t });
      if (!user || !user.isActive) {
        return { status: 'USER_INACTIVE' };
      }

      // Replay detection: Predecessor already marked revoked!
      if (stored.revokedAt !== null) {
        // Revoke all unrevoked tokens in this family within the transaction
        await RefreshToken.update(
          { revokedAt: new Date() },
          { where: { familyId: effectiveFamilyId, revokedAt: null }, transaction: t }
        );

        // Return outcome so Sequelize COMMITS the revocation rather than rolling it back!
        return {
          status: 'REPLAY_DETECTED',
          userId: stored.userId,
          familyId: effectiveFamilyId,
          tokenId: stored.tokenId,
        };
      }

      // Legitimate active token: Rotate atomically
      const newAccessToken = signAccessToken(user);
      const newRefreshToken = signRefreshToken(user, effectiveFamilyId);

      const successor = await RefreshToken.create(
        {
          userId: user.userId,
          familyId: effectiveFamilyId,
          tokenHash: hashToken(newRefreshToken),
          expiresAt: new Date(Date.now() + msFromExpiresIn(env.jwt.refreshExpiresIn)),
          createdByIp: ip,
        },
        { transaction: t }
      );

      stored.revokedAt = new Date();
      stored.replacedByTokenId = successor.tokenId;
      await stored.save({ transaction: t });

      return {
        status: 'SUCCESS',
        tokens: { accessToken: newAccessToken, refreshToken: newRefreshToken },
        userId: user.userId,
        familyId: effectiveFamilyId,
      };
    }
  );

  // 3. Post-transaction handling (after MySQL commit)
  if (outcome.status === 'REPLAY_DETECTED') {
    try {
      await auditLog.record({
        userId: outcome.userId,
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        entityType: 'RefreshToken',
        entityId: outcome.tokenId,
        ipAddress: ip,
        metadata: { familyId: outcome.familyId },
      });
    } catch (auditErr) {
      logger.warn(`Failed to record audit log for refresh token replay: ${auditErr.message}`);
    }
    return { status: 'REPLAY_DETECTED' };
  }

  if (outcome.status !== 'SUCCESS') {
    return null;
  }

  return outcome.tokens;
}

/** Revokes a single token and all tokens in its family (single-device/session logout). */
async function revokeRefreshToken(token) {
  if (!token || typeof token !== 'string') return;
  const tokenHash = hashToken(token);
  const stored = await RefreshToken.findOne({ where: { tokenHash } });
  if (stored) {
    await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { familyId: stored.familyId, revokedAt: null } }
    );
  }
}

/** Revokes all tokens across all families for a given user (password change/reset). */
async function revokeAllUserTokens(userId, transaction = null) {
  await RefreshToken.update(
    { revokedAt: new Date() },
    { where: { userId, revokedAt: null }, ...(transaction ? { transaction } : {}) }
  );
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  hashToken,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
};
