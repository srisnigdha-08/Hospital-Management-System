const { validateTestDatabaseSettings } = require('../../src/config/testDatabaseIdentity');

function requireTestEnvironment(environment = process.env) {
  if (environment.NODE_ENV !== 'test') {
    throw new Error('Database-backed tests require NODE_ENV=test; refusing to load the application');
  }
  validateTestDatabaseSettings({
    dbName: environment.DB_NAME,
    dbUser: environment.DB_USER,
    expectedServerUuid: environment.TEST_DB_SERVER_UUID,
  });
}

requireTestEnvironment();

module.exports = requireTestEnvironment;
