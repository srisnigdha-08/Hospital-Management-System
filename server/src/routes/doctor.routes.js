const router = require('express').Router();
const controller = require('../controllers/doctor.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { validate } = require('../validators/common');
const v = require('../validators/doctor.validator');

router.use(authenticate);

router.get('/', v.listQueryRules, validate, controller.listDoctors);
router.get('/:id', v.idParamRule, validate, controller.getDoctor);
router.post('/', authorize('admin'), v.createRules, validate, controller.createDoctor);
router.patch('/:id', authorize('admin'), v.updateRules, validate, controller.updateDoctor);
router.delete('/:id', authorize('admin'), v.idParamRule, validate, controller.deleteDoctor);
router.put('/:id/schedule', authorize('admin', 'doctor'), v.idParamRule, validate, controller.setSchedule);

module.exports = router;
