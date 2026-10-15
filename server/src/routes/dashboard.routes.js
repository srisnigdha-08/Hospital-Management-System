const router = require('express').Router();
const controller = require('../controllers/dashboard.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

router.use(authenticate);

router.get('/summary', controller.getSummary);
router.get('/appointments-trend', controller.getAppointmentsTrend);
router.get('/department-distribution', authorize('admin', 'receptionist'), controller.getDepartmentDistribution);
router.get('/monthly-stats', authorize('admin', 'receptionist'), controller.getMonthlyStats);

module.exports = router;
