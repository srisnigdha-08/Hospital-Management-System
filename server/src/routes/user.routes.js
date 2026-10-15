const router = require('express').Router();
const { body } = require('express-validator');
const controller = require('../controllers/user.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { validate } = require('../validators/common');

router.use(authenticate, authorize('admin'));

router.get('/', controller.listUsers);
router.get('/:id', controller.getUser);
router.post(
  '/',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('role').isIn(['admin', 'receptionist']),
  ],
  validate,
  controller.createStaffUser
);
router.patch('/:id', controller.updateUser);
router.delete('/:id', controller.deleteUser);

module.exports = router;
