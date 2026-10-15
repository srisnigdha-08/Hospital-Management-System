const ApiError = require('../utils/ApiError');

/**
 * Role-based access control. Usage: authorize('admin', 'doctor')
 * Must run after `authenticate`, which populates req.user.roleName.
 */
const authorize = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    throw ApiError.unauthorized('Authentication required');
  }
  if (!allowedRoles.includes(req.user.roleName)) {
    throw ApiError.forbidden(`Role "${req.user.roleName}" is not permitted to perform this action`);
  }
  next();
};

module.exports = authorize;
