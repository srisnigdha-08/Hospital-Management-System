const router = require('express').Router();
const controller = require('../controllers/medicalRecord.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const upload = require('../middleware/upload');
const { validate } = require('../validators/common');
const v = require('../validators/medicalRecord.validator');

router.use(authenticate);

router.get('/', authorize('doctor', 'admin', 'patient'), v.listQueryRules, validate, controller.listRecords);
router.get('/:id', authorize('doctor', 'admin', 'patient'), v.idParamRule, validate, controller.getRecord);
router.get('/:id/attachments/:attachmentId', authorize('doctor', 'admin', 'patient'), v.attachmentParamRules, validate, controller.downloadAttachment);
router.post('/', authorize('doctor', 'admin'), v.createRules, validate, controller.createRecord);
router.patch('/:id', authorize('doctor', 'admin'), v.updateRules, validate, controller.updateRecord);
router.post('/:id/attachments', authorize('doctor', 'admin'), v.idParamRule, validate, upload.single('file'), controller.uploadAttachment);

module.exports = router;

