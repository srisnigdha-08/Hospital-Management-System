const router = require('express').Router();
const controller = require('../controllers/appointment.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { validate } = require('../validators/common');
const v = require('../validators/appointment.validator');

router.use(authenticate);

router.get('/availability', v.availabilityQueryRules, validate, controller.getAvailableSlots);
router.get('/', v.listQueryRules, validate, controller.listAppointments);
router.get('/:id', v.idParamRule, validate, controller.getAppointment);
router.post('/', authorize('admin', 'receptionist', 'patient'), v.createRules, validate, controller.createAppointment);
router.patch('/:id/reschedule', authorize('admin', 'receptionist', 'patient'), v.rescheduleRules, validate, controller.rescheduleAppointment);
router.patch('/:id/cancel', authorize('admin', 'receptionist', 'patient', 'doctor'), v.cancelRules, validate, controller.cancelAppointment);
router.patch('/:id/status', authorize('admin', 'receptionist', 'doctor'), v.statusRules, validate, controller.updateStatus);

module.exports = router;
