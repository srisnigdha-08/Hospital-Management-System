const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { User, Role } = require('../models');

/**
 * Verifies the Bearer access token and attaches `req.user` (safe fields
 * only) plus `req.user.roleName` for downstream authorization checks.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Missing or malformed Authorization header');
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Access token expired');
    }
    throw ApiError.unauthorized('Invalid access token');
  }

  if (!Number.isInteger(payload.tokenVersion) || payload.tokenVersion < 0) {
    throw ApiError.unauthorized('Invalid access token');
  }

  const user = await User.findByPk(payload.sub, { include: [{ model: Role }] });
  if (!user || !user.isActive) {
    throw ApiError.unauthorized('Account not found or deactivated');
  }
  if (user.tokenVersion !== payload.tokenVersion) {
    throw ApiError.unauthorized('Invalid access token');
  }

  req.user = {
    userId: user.userId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roleId: user.roleId,
    roleName: user.Role.roleName,
  };
  next();
});

module.exports = authenticate;
