const router = require('express').Router();
const controller = require('../controllers/department.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { validate } = require('../validators/common');
const v = require('../validators/department.validator');

router.use(authenticate);

router.get('/', controller.listDepartments);
router.get('/:id', v.idParamRule, validate, controller.getDepartment);
router.post('/', authorize('admin'), v.createRules, validate, controller.createDepartment);
router.patch('/:id', authorize('admin'), v.updateRules, validate, controller.updateDepartment);
router.delete('/:id', authorize('admin'), v.idParamRule, validate, controller.deleteDepartment);

module.exports = router;
