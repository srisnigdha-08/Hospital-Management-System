const router = require('express').Router();
const controller = require('../controllers/search.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

router.get('/', authenticate, authorize('admin', 'receptionist', 'doctor'), controller.globalSearch);

module.exports = router;
