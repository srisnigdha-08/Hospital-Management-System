const rateLimit = require('express-rate-limit');
const env = require('../config/env');

// General API limiter — generous, mainly guards against runaway clients/bots.
const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMinutes * 60 * 1000,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

// Tighter limiter for auth endpoints — mitigates credential stuffing / brute force.
const authLimiter = rateLimit({
  windowMs: env.rateLimit.windowMinutes * 60 * 1000,
  max: env.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts. Please try again later.' },
});

module.exports = { apiLimiter, authLimiter };
