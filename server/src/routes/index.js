const router = require('express').Router();

router.use('/auth', require('./auth.routes'));
router.use('/users', require('./user.routes'));
router.use('/departments', require('./department.routes'));
router.use('/doctors', require('./doctor.routes'));
router.use('/patients', require('./patient.routes'));
router.use('/appointments', require('./appointment.routes'));
router.use('/medical-records', require('./medicalRecord.routes'));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/notifications', require('./notification.routes'));
router.use('/search', require('./search.routes'));

router.get('/health', (req, res) => res.json({ success: true, message: 'HMS API is running', timestamp: new Date().toISOString() }));

module.exports = router;
