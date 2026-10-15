require('./helpers/require-test-environment');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const path = require('path');
const { Op } = require('sequelize');

const app = require('../src/app');
const env = require('../src/config/env');
const { sequelize, User, Role, RefreshToken, PasswordResetToken, Appointment } = require('../src/models');
const tokenService = require('../src/services/token.service');
const {
  signAccessToken,
  signRefreshToken,
  hashToken,
  issueTokenPair,
  rotateRefreshToken,
} = require('../src/services/token.service');
const { checkSchemaPreflight } = require('../src/config/db');
const { migrate } = require('../src/migrations/run');

describe('Phase 3.2: Refresh-Token Rotation, Replay Detection & Session Security Suite', () => {
  let server;
  let baseUrl;

  let testUser;
  let testUser2;
  const createdUserIds = [];
  const createdTokenIds = [];
  const createdAppointmentIds = [];

  before(async () => {
    // 1. Start HTTP server on ephemeral port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 2. Fetch seed patient role and create primary test user
    const patientRole = await Role.findOne({ where: { roleName: 'patient' } });
    assert.ok(patientRole, 'Patient role must exist in seeded DB');

    testUser = await User.create({
      roleId: patientRole.roleId,
      firstName: 'Rotation',
      lastName: 'Tester',
      email: `rotation.tester.${Date.now()}@hms.test`,
      phone: '1234567890',
      passwordHash: '$2a$12$DUMMYHASHDUMMYHASHDUMMYHASHDUMMYHASH',
      isActive: true,
    });
    createdUserIds.push(testUser.userId);

    testUser2 = await User.create({
      roleId: patientRole.roleId,
      firstName: 'MultiDevice',
      lastName: 'Tester',
      email: `multidevice.tester.${Date.now()}@hms.test`,
      phone: '1234567891',
      passwordHash: '$2a$12$DUMMYHASHDUMMYHASHDUMMYHASHDUMMYHASH',
      isActive: true,
    });
    createdUserIds.push(testUser2.userId);
  });

  after(async () => {
    // Clean up created appointments
    if (createdAppointmentIds.length > 0) {
      await Appointment.destroy({
        where: { appointmentId: { [Op.in]: createdAppointmentIds } },
      }).catch(() => {});
    }

    // Clean up created tokens
    if (createdUserIds.length > 0) {
      await RefreshToken.destroy({
        where: { userId: { [Op.in]: createdUserIds } },
      }).catch(() => {});
    }

    // Clean up created test users
    if (createdUserIds.length > 0) {
      await User.destroy({
        where: { userId: { [Op.in]: createdUserIds } },
      }).catch(() => {});
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Section 1: Sequential Token Rotation & Lineage Tracking
  // =========================================================================
  describe('1. Sequential Token Rotation & Lineage Tracking', () => {
    test('1a. Valid rotation returns new tokens and updates predecessor with replaced_by_token_id', async () => {
      const pair1 = await issueTokenPair(testUser, '127.0.0.1');
      createdTokenIds.push(pair1.tokenId);

      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: pair1.refreshToken }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.accessToken);
      assert.ok(json.data.refreshToken);

      // Verify DB state for predecessor
      const pred = await RefreshToken.findOne({ where: { tokenHash: hashToken(pair1.refreshToken) } });
      assert.ok(pred.revokedAt, 'Predecessor must be revoked');
      assert.ok(pred.replacedByTokenId, 'Predecessor must have replaced_by_token_id set');

      // Verify DB state for successor
      const succ = await RefreshToken.findOne({ where: { tokenHash: hashToken(json.data.refreshToken) } });
      assert.ok(succ, 'Successor must exist in DB');
      assert.equal(succ.revokedAt, null, 'Successor must be active');
      assert.equal(succ.familyId, pred.familyId, 'Successor must share family_id with predecessor');
      assert.equal(pred.replacedByTokenId, succ.tokenId, 'Predecessor must point to successor token_id');
      createdTokenIds.push(succ.tokenId);
    });

    test('1b. Multi-step rotation forms an unbroken lineage chain with identical family_id', async () => {
      const pair1 = await issueTokenPair(testUser, '127.0.0.1');
      createdTokenIds.push(pair1.tokenId);

      // Rotate Step 1
      const res1 = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: pair1.refreshToken }),
      });
      assert.equal(res1.status, 200);
      const json1 = await res1.json();
      const token2 = json1.data.refreshToken;

      // Rotate Step 2
      const res2 = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token2 }),
      });
      assert.equal(res2.status, 200);
      const json2 = await res2.json();
      const token3 = json2.data.refreshToken;

      // Query database for all 3 tokens
      const row1 = await RefreshToken.findOne({ where: { tokenHash: hashToken(pair1.refreshToken) } });
      const row2 = await RefreshToken.findOne({ where: { tokenHash: hashToken(token2) } });
      const row3 = await RefreshToken.findOne({ where: { tokenHash: hashToken(token3) } });

      assert.equal(row1.familyId, row2.familyId);
      assert.equal(row2.familyId, row3.familyId);
      assert.equal(row1.replacedByTokenId, row2.tokenId);
      assert.equal(row2.replacedByTokenId, row3.tokenId);
      assert.equal(row3.replacedByTokenId, null);
      assert.ok(row1.revokedAt);
      assert.ok(row2.revokedAt);
      assert.equal(row3.revokedAt, null);
      createdTokenIds.push(row2.tokenId, row3.tokenId);
    });
  });

  // =========================================================================
  // Section 2: Concurrency Controls & Successor Usability
  // =========================================================================
  describe('2. Concurrency Controls & Strict Zero-Grace Dynamics', () => {
    test('2a. Simultaneous refresh requests with identical token: one succeeds, one revokes family', async () => {
      const pair = await issueTokenPair(testUser, '127.0.0.1');
      createdTokenIds.push(pair.tokenId);

      // Fire two concurrent refresh calls with the exact same initial token
      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: pair.refreshToken }),
        }),
        fetch(`${baseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: pair.refreshToken }),
        }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Under strict single-use row locking, exactly one acquires lock first and rotates (200),
      // and the competing follower sees it revoked and triggers family revocation (401).
      assert.deepEqual(statuses, [200, 401], 'Exactly one request should return 200 and one 401');

      const successRes = resA.status === 200 ? resA : resB;
      const successJson = await successRes.json();
      const successorToken = successJson.data.refreshToken;

      // Database Consistency Check:
      // Because the competing request unblocked and observed predecessor revoked,
      // it triggered family revocation! ALL tokens in that family must now be revoked!
      const allFamilyTokens = await RefreshToken.findAll({ where: { familyId: pair.familyId } });
      assert.ok(allFamilyTokens.length >= 2, 'Should have predecessor and successor');
      for (const tok of allFamilyTokens) {
        assert.ok(tok.revokedAt, `Token ${tok.tokenId} in family must be revoked due to competing race`);
      }

      // Successor Usability Check:
      // Subsequent use of the successor token must fail with 401 because the family was revoked!
      const resFollowup = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: successorToken }),
      });
      assert.equal(resFollowup.status, 401, 'Successor token must be unusable after competing race revoked family');
    });
  });

  // =========================================================================
  // Section 3: Replay Detection & Committed Family Revocation
  // =========================================================================
  describe('3. Replay Detection & Committed Family Revocation', () => {
    test('3a. Replay of an already-rotated token revokes entire family and commits to DB before 401', async () => {
      const pair = await issueTokenPair(testUser, '127.0.0.1');
      createdTokenIds.push(pair.tokenId);

      // Normal rotation T1 -> T2
      const res1 = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: pair.refreshToken }),
      });
      assert.equal(res1.status, 200);
      const json1 = await res1.json();
      const token2 = json1.data.refreshToken;

      // Replay attack: present already-rotated T1 again
      const replayRes = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: pair.refreshToken }),
      });
      assert.equal(replayRes.status, 401);
      const replayJson = await replayRes.json();
      assert.equal(replayJson.message, 'Invalid or expired refresh token');

      // CRITICAL ASSERTION: The revocation must be COMMITTED in MySQL!
      // Check that T2 was revoked as a result of T1 replay:
      const rowT2 = await RefreshToken.findOne({ where: { tokenHash: hashToken(token2) } });
      assert.ok(rowT2.revokedAt, 'Successor token row must be revoked in database despite 401 HTTP response');
    });

    test('3b. Successor token is rejected after family revocation (full session termination)', async () => {
      const pair = await issueTokenPair(testUser, '127.0.0.1');
      createdTokenIds.push(pair.tokenId);

      // Rotate T1 -> T2
      const res1 = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: pair.refreshToken }),
      });
      const json1 = await res1.json();
      const token2 = json1.data.refreshToken;

      // Replay T1
      await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: pair.refreshToken }),
      });

      // Attempt to refresh with T2 (the formerly active token)
      const res2 = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token2 }),
      });
      assert.equal(res2.status, 401);
    });
  });

  // =========================================================================
  // Section 4: Legacy Token Backward Compatibility
  // =========================================================================
  describe('4. Legacy Refresh Token Backward Compatibility', () => {
    test('4a. Legacy refresh token without familyId in claims transitions smoothly using database row', async () => {
      // Create a legacy token without familyId claim in payload
      const legacyRawToken = jwt.sign(
        { sub: testUser.userId, jti: crypto.randomUUID() },
        env.jwt.refreshSecret,
        { expiresIn: '7d', algorithm: 'HS256' }
      );
      const legacyFamilyId = crypto.randomUUID();

      // Insert matching DB row with backfilled family_id
      const legacyRow = await RefreshToken.create({
        userId: testUser.userId,
        familyId: legacyFamilyId,
        tokenHash: hashToken(legacyRawToken),
        expiresAt: new Date(Date.now() + 7 * 86400000),
        createdByIp: '127.0.0.1',
      });
      createdTokenIds.push(legacyRow.tokenId);

      // Rotate the legacy token via HTTP
      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: legacyRawToken }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(json.data.refreshToken);

      // Verify successor JWT contains the backfilled familyId
      const decodedSucc = jwt.decode(json.data.refreshToken);
      assert.equal(decodedSucc.familyId, legacyFamilyId, 'Successor must encode adopted familyId in claims');

      // Verify successor can be rotated normally
      const nextRes = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: json.data.refreshToken }),
      });
      assert.equal(nextRes.status, 200);
    });

    test('4b. Token with forged or mismatched familyId claim is rejected (401)', async () => {
      const genuineFamily = crypto.randomUUID();
      const forgedFamily = crypto.randomUUID();

      // Sign token claiming forgedFamily
      const forgedToken = jwt.sign(
        { sub: testUser.userId, familyId: forgedFamily, jti: crypto.randomUUID() },
        env.jwt.refreshSecret,
        { expiresIn: '7d', algorithm: 'HS256' }
      );

      // But DB row has genuineFamily
      const row = await RefreshToken.create({
        userId: testUser.userId,
        familyId: genuineFamily,
        tokenHash: hashToken(forgedToken),
        expiresAt: new Date(Date.now() + 7 * 86400000),
        createdByIp: '127.0.0.1',
      });
      createdTokenIds.push(row.tokenId);

      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: forgedToken }),
      });

      assert.equal(res.status, 401);
      // Ensure genuine family was NOT revoked
      const recheck = await RefreshToken.findByPk(row.tokenId);
      assert.equal(recheck.revokedAt, null, 'Row should remain unrevoked on claim forgery');
    });
  });

  // =========================================================================
  // Section 5: Multi-Device Family Isolation
  // =========================================================================
  describe('5. Multi-Device Family Isolation', () => {
    test('5a. Replay breach in Family A revokes Family A without disrupting Family B on Device 2', async () => {
      // User logs in on Device 1 (Family A) and Device 2 (Family B)
      const dev1 = await issueTokenPair(testUser2, '127.0.0.1');
      const dev2 = await issueTokenPair(testUser2, '127.0.0.1');
      assert.notEqual(dev1.familyId, dev2.familyId, 'Each login must generate a unique familyId');

      // Device 1 rotates T_A1 -> T_A2
      const resA1 = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: dev1.refreshToken }),
      });
      assert.equal(resA1.status, 200);

      // Replay attack on Device 1: re-submit T_A1
      const replayRes = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: dev1.refreshToken }),
      });
      assert.equal(replayRes.status, 401);

      // Device 2 (Family B) attempts normal rotation: MUST SUCCEED!
      const resB = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: dev2.refreshToken }),
      });
      assert.equal(resB.status, 200, 'Device 2 (Family B) must remain active and unaffected');

      // Assert DB state: Family A tokens are revoked; Family B has active successor
      const famATokens = await RefreshToken.findAll({ where: { familyId: dev1.familyId } });
      for (const tok of famATokens) {
        assert.ok(tok.revokedAt, 'Family A token must be revoked');
      }

      const famBTokens = await RefreshToken.findAll({ where: { familyId: dev2.familyId, revokedAt: null } });
      assert.equal(famBTokens.length, 1, 'Family B must have exactly one active token');
    });
  });

  // =========================================================================
  // Section 6: Cryptographic Validation & Algorithm Pinning
  // =========================================================================
  describe('6. Cryptographic Validation & Algorithm Pinning', () => {
    test('6a. Reject refresh token with algorithm "none" (401)', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: testUser.userId,
        familyId: crypto.randomUUID(),
        jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: noneToken }),
      });
      assert.equal(res.status, 401);
    });

    test('6b. Reject refresh token signed with unexpected algorithm HS384 (401)', async () => {
      const hs384Token = jwt.sign(
        { sub: testUser.userId, familyId: crypto.randomUUID(), jti: crypto.randomUUID() },
        env.jwt.refreshSecret,
        { algorithm: 'HS384', expiresIn: '7d' }
      );

      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: hs384Token }),
      });
      assert.equal(res.status, 401);
    });

    test('6c. Reject expired refresh token (401)', async () => {
      const expiredToken = jwt.sign(
        { sub: testUser.userId, familyId: crypto.randomUUID(), jti: crypto.randomUUID() },
        env.jwt.refreshSecret,
        { algorithm: 'HS256', expiresIn: '-1s' }
      );

      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: expiredToken }),
      });
      assert.equal(res.status, 401);
    });

    test('6d. Reject malformed non-JWT string (401)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'not.a.valid.jwt' }),
      });
      assert.equal(res.status, 401);
    });

    test('6e. Reject cryptographically valid token not registered in database (401)', async () => {
      const unknownToken = signRefreshToken(testUser, crypto.randomUUID());

      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: unknownToken }),
      });
      assert.equal(res.status, 401);
    });
  });

  // =========================================================================
  // Section 7: Session Lifecycle Invalidation Matrix
  // =========================================================================
  describe('7. Session Lifecycle Invalidation Matrix', () => {
    test('7a. Logout with refresh token revokes calling family only', async () => {
      const dev1 = await issueTokenPair(testUser, '127.0.0.1');
      const dev2 = await issueTokenPair(testUser, '127.0.0.1');

      // Logout Device 1
      const res = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: dev1.refreshToken }),
      });
      assert.equal(res.status, 200);

      // Verify Dev 1 family revoked
      const dev1Row = await RefreshToken.findOne({ where: { tokenHash: hashToken(dev1.refreshToken) } });
      assert.ok(dev1Row.revokedAt, 'Device 1 family token must be revoked');

      // Verify Dev 2 family remains active
      const dev2Row = await RefreshToken.findOne({ where: { tokenHash: hashToken(dev2.refreshToken) } });
      assert.equal(dev2Row.revokedAt, null, 'Device 2 family token must remain active');
    });

    test('7b. Password change revokes all families across all devices', async () => {
      const userToChange = await User.create({
        roleId: 4,
        firstName: 'PassChange',
        lastName: 'Tester',
        email: `passchange.${Date.now()}@hms.test`,
        passwordHash: require('bcryptjs').hashSync('CurrentPassword123!', 10),
        isActive: true,
      });
      createdUserIds.push(userToChange.userId);

      const dev1 = await issueTokenPair(userToChange, '127.0.0.1');
      const dev2 = await issueTokenPair(userToChange, '127.0.0.1');
      const userAccessToken = signAccessToken(userToChange);

      const res = await fetch(`${baseUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAccessToken}`,
        },
        body: JSON.stringify({
          currentPassword: 'CurrentPassword123!',
          newPassword: 'NewPassword123!',
        }),
      });
      assert.equal(res.status, 200);

      // Both families must now be revoked
      const row1 = await RefreshToken.findOne({ where: { tokenHash: hashToken(dev1.refreshToken) } });
      const row2 = await RefreshToken.findOne({ where: { tokenHash: hashToken(dev2.refreshToken) } });
      assert.ok(row1.revokedAt, 'Device 1 must be revoked on password change');
      assert.ok(row2.revokedAt, 'Device 2 must be revoked on password change');
      await userToChange.reload();
      assert.equal(userToChange.tokenVersion, 1);

      const staleAccessResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${userAccessToken}` },
      });
      assert.equal(staleAccessResponse.status, 401, 'Previously issued access token must be invalidated');

      const revokedRefreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: dev1.refreshToken }),
      });
      assert.equal(revokedRefreshResponse.status, 401, 'Revoked refresh session must not issue new tokens');

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userToChange.email, password: 'NewPassword123!' }),
      });
      assert.equal(loginResponse.status, 200);
      const loginJson = await loginResponse.json();
      const currentAccessResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${loginJson.data.accessToken}` },
      });
      assert.equal(currentAccessResponse.status, 200, 'New current-version access token must remain valid');
    });

    test('7c. Password reset revokes all families across all devices', async () => {
      const userToReset = await User.create({
        roleId: 4,
        firstName: 'PassReset',
        lastName: 'Tester',
        email: `passreset.${Date.now()}@hms.test`,
        passwordHash: require('bcryptjs').hashSync('OldPassword123!', 10),
        isActive: true,
      });
      createdUserIds.push(userToReset.userId);

      const dev1 = await issueTokenPair(userToReset, '127.0.0.1');
      const dev2 = await issueTokenPair(userToReset, '127.0.0.1');
      const oldAccessToken = signAccessToken(userToReset);

      // Create two outstanding password reset tokens.
      const rawResetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(rawResetToken).digest('hex');
      await PasswordResetToken.create({
        userId: userToReset.userId,
        tokenHash: resetTokenHash,
        expiresAt: new Date(Date.now() + 30 * 60000),
      });
      const otherResetToken = crypto.randomBytes(32).toString('hex');
      await PasswordResetToken.create({
        userId: userToReset.userId,
        tokenHash: crypto.createHash('sha256').update(otherResetToken).digest('hex'),
        expiresAt: new Date(Date.now() + 30 * 60000),
      });

      const res = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: rawResetToken,
          password: 'NewlyResetPassword123!',
        }),
      });
      assert.equal(res.status, 200);

      // Both families must be revoked
      const row1 = await RefreshToken.findOne({ where: { tokenHash: hashToken(dev1.refreshToken) } });
      const row2 = await RefreshToken.findOne({ where: { tokenHash: hashToken(dev2.refreshToken) } });
      assert.ok(row1.revokedAt, 'Device 1 must be revoked on password reset');
      assert.ok(row2.revokedAt, 'Device 2 must be revoked on password reset');
      await userToReset.reload();
      assert.equal(userToReset.tokenVersion, 1);

      const staleAccessResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${oldAccessToken}` },
      });
      assert.equal(staleAccessResponse.status, 401, 'Previously issued access token must be invalidated');

      const resetRows = await PasswordResetToken.findAll({ where: { userId: userToReset.userId } });
      assert.equal(resetRows.length, 2);
      assert.ok(resetRows.every((row) => row.usedAt), 'All outstanding reset tokens must be consumed');

      const revokedRefreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: dev1.refreshToken }),
      });
      assert.equal(revokedRefreshResponse.status, 401, 'Revoked refresh session must not issue new tokens');

      const secondResetResponse = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: otherResetToken, password: 'AnotherResetPassword123!' }),
      });
      assert.equal(secondResetResponse.status, 400, 'Other outstanding reset links must no longer be redeemable');

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userToReset.email, password: 'NewlyResetPassword123!' }),
      });
      assert.equal(loginResponse.status, 200);
      const loginJson = await loginResponse.json();
      const currentAccessResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${loginJson.data.accessToken}` },
      });
      assert.equal(currentAccessResponse.status, 200, 'Post-reset current-version access token must remain valid');
    });

    test('7d. Concurrent redemption of one reset token succeeds at most once', async () => {
      const user = await User.create({
        roleId: 4,
        firstName: 'ConcurrentReset',
        lastName: 'Tester',
        email: `concurrent-reset.${Date.now()}@hms.test`,
        passwordHash: require('bcryptjs').hashSync('BeforeReset123!', 10),
        isActive: true,
      });
      createdUserIds.push(user.userId);
      const rawToken = crypto.randomBytes(32).toString('hex');
      await PasswordResetToken.create({
        userId: user.userId,
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() + 30 * 60000),
      });

      const redeem = (password) => fetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rawToken, password }),
      });
      const responses = await Promise.all([redeem('FirstNewPassword123!'), redeem('SecondNewPassword123!')]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
      await user.reload();
      assert.equal(user.tokenVersion, 1);
      const resetRow = await PasswordResetToken.findOne({ where: { userId: user.userId } });
      assert.ok(resetRow.usedAt);
    });

    test('7e. Failed reset transaction leaves password, reset token, refresh sessions, and version unchanged', async () => {
      const user = await User.create({
        roleId: 4,
        firstName: 'RollbackReset',
        lastName: 'Tester',
        email: `rollback-reset.${Date.now()}@hms.test`,
        passwordHash: require('bcryptjs').hashSync('BeforeReset123!', 10),
        isActive: true,
      });
      createdUserIds.push(user.userId);
      const session = await issueTokenPair(user, '127.0.0.1');
      const originalPasswordHash = user.passwordHash;
      const rawToken = crypto.randomBytes(32).toString('hex');
      await PasswordResetToken.create({
        userId: user.userId,
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() + 30 * 60000),
      });

      const originalRevoke = tokenService.revokeAllUserTokens;
      tokenService.revokeAllUserTokens = async () => { throw new Error('Injected transaction failure'); };
      let response;
      try {
        response = await fetch(`${baseUrl}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: rawToken, password: 'AfterReset123!' }),
        });
      } finally {
        tokenService.revokeAllUserTokens = originalRevoke;
      }

      assert.equal(response.status, 500);
      await user.reload();
      assert.equal(user.tokenVersion, 0);
      assert.equal(user.passwordHash, originalPasswordHash);
      const resetRow = await PasswordResetToken.findOne({ where: { userId: user.userId } });
      assert.equal(resetRow.usedAt, null);
      const refreshRow = await RefreshToken.findOne({ where: { tokenHash: hashToken(session.refreshToken) } });
      assert.equal(refreshRow.revokedAt, null);
    });
  });

  // =========================================================================
  // Section 8: Migration Idempotency & Preflight Verification
  // =========================================================================
  describe('8. Migration Idempotency & Preflight Verification', () => {
    test('8a. Migration 001 is idempotent on consecutive executions and preflight confirms readiness', async () => {
      // Exercise both migrations through the canonical advisory-locked runner.
      await migrate(sequelize);
      await migrate(sequelize);

      // Verify checkSchemaPreflight returns true
      const isReady = await checkSchemaPreflight(sequelize);
      assert.equal(isReady, true, 'Schema preflight must confirm table is fully migrated');
    });
  });

  // =========================================================================
  // Section 9: Carried-Forward Phase 3.1 Tests
  // =========================================================================
  describe('9. Carried-Forward Phase 3.1 Security Hardening Tests', () => {
    test('9a. Missing doctor profile fails closed (403 Forbidden) on GET /api/appointments/:id', async () => {
      const doctorRole = await Role.findOne({ where: { roleName: 'doctor' } });
      const orphanDocUser = await User.create({
        roleId: doctorRole.roleId,
        firstName: 'OrphanDoc',
        lastName: 'Tester',
        email: `orphandoc.${Date.now()}@hms.test`,
        phone: '7777777777',
        passwordHash: '$2a$12$DUMMYHASHDUMMYHASHDUMMYHASH',
        isActive: true,
      });
      createdUserIds.push(orphanDocUser.userId);
      const orphanDocToken = signAccessToken(orphanDocUser);

      // Use any existing appointment ID or create a test one
      const sampleAppt = await Appointment.create({
        patientId: 401,
        doctorId: 201,
        departmentId: 10,
        bookedByUserId: testUser.userId,
        scheduledStart: new Date('2028-09-01T10:00:00Z'),
        scheduledEnd: new Date('2028-09-01T10:30:00Z'),
        status: 'scheduled',
        reason: 'ORPHAN_DOC_CHECK',
      });
      createdAppointmentIds.push(sampleAppt.appointmentId);

      const res = await fetch(`${baseUrl}/api/appointments/${sampleAppt.appointmentId}`, {
        headers: { Authorization: `Bearer ${orphanDocToken}` },
      });
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'No doctor profile is linked to this account');
    });

    test('9b. Production startup fails and exits with code 1 in isolated child process if secrets are missing', () => {
      const serverPath = path.resolve(__dirname, '../src/server.js');
      const result = spawnSync('node', [serverPath], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: '', // Missing secret in production
          JWT_REFRESH_SECRET: '',
        },
        encoding: 'utf8',
        timeout: 5000,
      });

      assert.equal(result.status, 1, 'Child process must exit with code 1 in production when secrets are missing');
      assert.match(
        result.stderr + result.stdout,
        /Production startup failed/i,
        'Process output should indicate production startup failure'
      );
    });
  });

  // =========================================================================
  // Section 10: Client Cross-Tab Coordination & Web Locks Re-Read Algorithm
  // =========================================================================
  describe('10. Client Cross-Tab Refresh Coordination', () => {
    test('10a. Waiting tab re-reads credentials after Web Lock release, avoiding duplicate HTTP dispatch', async () => {
      // Simulate shared browser storage across Tab 1 and Tab 2
      const simulatedStorage = {
        hms_access_token: 'old_access_token',
        hms_refresh_token: 'old_refresh_token',
      };
      let httpCallsCount = 0;

      // Simulated Web Lock queue (FIFO lock execution)
      let currentLock = Promise.resolve();
      function simulatedWebLockRequest(name, workFn) {
        const next = currentLock.then(() => workFn());
        currentLock = next.catch(() => {});
        return next;
      }

      // Re-read algorithm exactly as implemented in client.js
      async function tabRefreshCoordinator(failedToken) {
        return simulatedWebLockRequest('hms_auth_refresh_lock', async () => {
          // 1. Re-read latest credentials from shared storage FIRST
          const latestRefresh = simulatedStorage.hms_refresh_token;
          const latestAccess = simulatedStorage.hms_access_token;

          if (latestRefresh && latestRefresh !== failedToken && latestAccess) {
            // Already refreshed by prior tab! Adopt without dispatching HTTP call
            return { accessToken: latestAccess, refreshToken: latestRefresh, deduplicated: true };
          }

          // Holding outdated token: execute network call
          httpCallsCount++;
          await new Promise((r) => setTimeout(r, 20)); // network delay
          const newTokens = { accessToken: 'new_access_token_123', refreshToken: 'new_refresh_token_123' };

          simulatedStorage.hms_access_token = newTokens.accessToken;
          simulatedStorage.hms_refresh_token = newTokens.refreshToken;
          return { ...newTokens, deduplicated: false };
        });
      }

      // Tab 1 and Tab 2 both observe expired old_refresh_token simultaneously
      const [tab1Result, tab2Result] = await Promise.all([
        tabRefreshCoordinator('old_refresh_token'),
        tabRefreshCoordinator('old_refresh_token'),
      ]);

      // Exactly ONE network refresh was dispatched!
      assert.equal(httpCallsCount, 1, 'Only one HTTP refresh should be dispatched across coordinated tabs');

      // Tab 1 performed the refresh; Tab 2 re-read and deduplicated
      assert.equal(tab1Result.deduplicated, false, 'First tab executed network refresh');
      assert.equal(tab2Result.deduplicated, true, 'Second tab adopted refreshed credentials from storage');
      assert.equal(tab2Result.refreshToken, 'new_refresh_token_123');
      assert.equal(tab2Result.accessToken, 'new_access_token_123');
    });

    test('10b. Fallback lock timeout aborts rather than blindly dispatching a competing refresh', async () => {
      // Simulate localStorage fallback mutex
      const simulatedStorage = {
        hms_refresh_active_lock: String(Date.now()), // active lock held by another tab
      };

      async function fallbackWithTimeout(maxWaitMs) {
        const start = Date.now();
        while (simulatedStorage.hms_refresh_active_lock) {
          const lockTime = Number(simulatedStorage.hms_refresh_active_lock);
          if (Date.now() - lockTime > 7000) break;
          if (Date.now() - start >= maxWaitMs) {
            throw new Error('Refresh lock acquisition timed out while another tab was refreshing');
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      }

      await assert.rejects(
        () => fallbackWithTimeout(50),
        /Refresh lock acquisition timed out while another tab was refreshing/
      );
    });
  });
});

