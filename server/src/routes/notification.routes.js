const router = require('express').Router();
const controller = require('../controllers/notification.controller');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

router.get('/', controller.listMyNotifications);
router.patch('/:id/read', controller.markAsRead);
router.patch('/read-all', controller.markAllAsRead);

module.exports = router;
