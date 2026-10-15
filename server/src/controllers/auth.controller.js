const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sequelize, User, Role, Patient, Doctor } = require('../models');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const tokenService = require('../services/token.service');
const emailService = require('../services/email.service');
const auditLog = require('../services/auditLog.service');
const env = require('../config/env');
const { PasswordResetToken } = require('../models');
const { Op, Transaction } = require('sequelize');

const SALT_ROUNDS = 12;

/**
 * Public self-registration. Always creates a `patient` account — staff
 * accounts (doctor/receptionist/admin) are provisioned by an administrator
 * via the Doctor Management / User Management screens, never through this
 * open endpoint, so a client can never grant itself elevated access.
 */
const register = asyncHandler(async (req, res) => {
  const { firstName, lastName, email, phone, password, dateOfBirth, gender, bloodGroup } = req.body;

  if (!dateOfBirth || !gender) {
    throw ApiError.badRequest('dateOfBirth and gender are required to register as a patient');
  }

  const existing = await User.findOne({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const patientRole = await Role.findOne({ where: { roleName: 'patient' } });
  if (!patientRole) throw ApiError.internal('Patient role is not seeded. Run the database seed script.');

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await sequelize.transaction(async (t) => {
    const user = await User.create(
      { roleId: patientRole.roleId, firstName, lastName, email, phone, passwordHash },
      { transaction: t }
    );

    const patient = await Patient.create(
      {
        userId: user.userId,
        dateOfBirth,
        gender,
        bloodGroup: bloodGroup || 'unknown',
        registrationNumber: `REG-TMP-${crypto.randomBytes(4).toString('hex')}`,
      },
      { transaction: t }
    );
    patient.registrationNumber = `REG-${String(patient.patientId).padStart(6, '0')}`;
    await patient.save({ transaction: t });

    return { user, patient };
  });

  await auditLog.record({
    userId: result.user.userId,
    action: 'REGISTER',
    entityType: 'User',
    entityId: result.user.userId,
    ipAddress: req.ip,
  });

  const tokens = await tokenService.issueTokenPair(result.user, req.ip);

  new ApiResponse(
    201,
    { user: result.user.toSafeJSON(), patientId: result.patient.patientId, ...tokens },
    'Registration successful'
  ).send(res);
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ where: { email }, include: [{ model: Role }] });
  if (!user) throw ApiError.unauthorized('Invalid email or password');

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) throw ApiError.unauthorized('Invalid email or password');

  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated. Contact an administrator.');

  user.lastLoginAt = new Date();
  await user.save();

  const tokens = await tokenService.issueTokenPair(user, req.ip);

  await auditLog.record({ userId: user.userId, action: 'LOGIN', entityType: 'User', entityId: user.userId, ipAddress: req.ip });

  new ApiResponse(200, { user: { ...user.toSafeJSON(), roleName: user.Role.roleName }, ...tokens }, 'Login successful').send(res);
});

const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const result = await tokenService.rotateRefreshToken(refreshToken, req.ip);
  if (!result || result.status === 'REPLAY_DETECTED') {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  new ApiResponse(200, result, 'Token refreshed').send(res);
});

const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await tokenService.revokeRefreshToken(refreshToken);
  new ApiResponse(200, null, 'Logged out').send(res);
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.userId, { include: [{ model: Role }] });
  if (!user) throw ApiError.notFound('User not found');

  let profile = null;
  if (user.Role.roleName === 'patient') {
    profile = await Patient.findOne({ where: { userId: user.userId } });
  } else if (user.Role.roleName === 'doctor') {
    profile = await Doctor.findOne({ where: { userId: user.userId } });
  }

  new ApiResponse(200, { user: { ...user.toSafeJSON(), roleName: user.Role.roleName }, profile }).send(res);
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ where: { email } });

  // Always return 200 — never reveal whether an email is registered.
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + env.passwordReset.expiresMinutes * 60 * 1000);

    await PasswordResetToken.create({ userId: user.userId, tokenHash, expiresAt });

    const resetLink = `${env.clientUrl}/reset-password?token=${rawToken}`;
    await emailService.send({
      to: user.email,
      subject: 'Reset your Hospital Management System password',
      text: `Use this link within ${env.passwordReset.expiresMinutes} minutes to reset your password: ${resetLink}`,
    });
  }

  new ApiResponse(200, null, 'If an account exists, reset instructions will be sent when email delivery is configured.').send(res);
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date();

  const candidate = await PasswordResetToken.findOne({
    where: { tokenHash, usedAt: null, expiresAt: { [Op.gt]: now } },
  });
  if (!candidate) throw ApiError.badRequest('This reset link is invalid or has expired');

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const userId = await sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
    async (transaction) => {
      // Lock the user first so simultaneous redemptions for one account serialize.
      const user = await User.findByPk(candidate.userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!user) throw ApiError.badRequest('This reset link is invalid or has expired');

      const resetToken = await PasswordResetToken.findOne({
        where: { tokenHash, userId: user.userId, usedAt: null, expiresAt: { [Op.gt]: new Date() } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!resetToken) throw ApiError.badRequest('This reset link is invalid or has expired');

      user.passwordHash = passwordHash;
      user.tokenVersion += 1;
      await user.save({ transaction });

      await PasswordResetToken.update(
        { usedAt: new Date() },
        { where: { userId: user.userId, usedAt: null }, transaction }
      );
      await tokenService.revokeAllUserTokens(user.userId, transaction);
      return user.userId;
    }
  );

  await auditLog.record({ userId, action: 'RESET_PASSWORD', entityType: 'User', entityId: userId, ipAddress: req.ip });

  new ApiResponse(200, null, 'Password reset successful. Please log in again.').send(res);
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findByPk(req.user.userId);
  if (!user) throw ApiError.notFound('User not found');

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) throw ApiError.badRequest('Current password is incorrect');

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
    async (transaction) => {
      const lockedUser = await User.findByPk(user.userId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lockedUser) throw ApiError.notFound('User not found');
      if (lockedUser.passwordHash !== user.passwordHash) {
        throw ApiError.badRequest('Current password is incorrect');
      }

      lockedUser.passwordHash = passwordHash;
      lockedUser.tokenVersion += 1;
      await lockedUser.save({ transaction });
      await tokenService.revokeAllUserTokens(lockedUser.userId, transaction);
    }
  );

  await auditLog.record({ userId: user.userId, action: 'CHANGE_PASSWORD', entityType: 'User', entityId: user.userId, ipAddress: req.ip });

  new ApiResponse(200, null, 'Password changed. Please log in again.').send(res);
});

module.exports = { register, login, refresh, logout, me, forgotPassword, resetPassword, changePassword };
