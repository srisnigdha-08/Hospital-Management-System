const router = require('express').Router();
const controller = require('../controllers/patient.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { validate } = require('../validators/common');
const v = require('../validators/patient.validator');

router.use(authenticate);

router.get('/me', controller.getMyPatientProfile);
router.get('/', authorize('admin', 'receptionist', 'doctor'), v.listQueryRules, validate, controller.listPatients);
router.get('/:id', v.idParamRule, validate, controller.getPatient);
router.post('/', authorize('admin', 'receptionist'), v.createRules, validate, controller.createPatient);
router.patch('/:id', v.updateRules, validate, controller.updatePatient);
router.delete('/:id', authorize('admin', 'receptionist'), v.idParamRule, validate, controller.deletePatient);
router.post('/:id/emergency-contacts', v.idParamRule, v.emergencyContactRules, validate, controller.addEmergencyContact);
router.post('/:id/insurance', v.idParamRule, v.insuranceRules, validate, controller.addInsurance);

module.exports = router;
