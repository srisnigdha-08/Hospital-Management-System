const router = require('express').Router();
const controller = require('../controllers/auth.controller');
const authenticate = require('../middleware/authenticate');
const { validate } = require('../validators/common');
const { authLimiter } = require('../middleware/rateLimiter');
const v = require('../validators/auth.validator');

router.post('/register', authLimiter, v.registerRules, validate, controller.register);
router.post('/login', authLimiter, v.loginRules, validate, controller.login);
router.post('/refresh', v.refreshRules, validate, controller.refresh);
router.post('/logout', controller.logout);
router.get('/me', authenticate, controller.me);
router.post('/forgot-password', authLimiter, v.forgotPasswordRules, validate, controller.forgotPassword);
router.post('/reset-password', authLimiter, v.resetPasswordRules, validate, controller.resetPassword);
router.post('/change-password', authenticate, v.changePasswordRules, validate, controller.changePassword);

module.exports = router;
