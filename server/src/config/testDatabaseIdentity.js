const TEST_DATABASE_NAME = 'hospital_management_test_fresh';
const MYSQL_SERVER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_MYSQL_SERVER_UUID = '00000000-0000-0000-0000-000000000000';

function normalizeMysqlServerUuid(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!MYSQL_SERVER_UUID_PATTERN.test(normalized) || normalized === NIL_MYSQL_SERVER_UUID) return null;
  return normalized;
}

function validateTestDatabaseSettings({ dbName, dbUser, expectedServerUuid }) {
  if (dbName !== TEST_DATABASE_NAME) {
    throw new Error(`Test mode requires DB_NAME to be exactly ${TEST_DATABASE_NAME}; refusing database access`);
  }
  if (!dbUser || !dbUser.trim() || dbUser.trim().toLowerCase() === 'root') {
    throw new Error('Test mode requires an explicitly configured non-root DB_USER');
  }
  if (!normalizeMysqlServerUuid(expectedServerUuid)) {
    throw new Error('Test mode requires an explicitly configured, operator-verified TEST_DB_SERVER_UUID');
  }
}

module.exports = {
  TEST_DATABASE_NAME,
  normalizeMysqlServerUuid,
  validateTestDatabaseSettings,
};
