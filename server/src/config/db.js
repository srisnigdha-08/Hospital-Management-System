const { Sequelize } = require('sequelize');
const env = require('./env');
const logger = require('../utils/logger');
const { normalizeMysqlServerUuid } = require('./testDatabaseIdentity');
const { inspectReminderSchema } = require('../migrations/reminderSchemaContract');

function discardRejectedConnection(connection) {
  try {
    connection.destroy?.();
  } catch {
    // A rejected connection must never return to the pool.
  }
}

async function verifyTestDatabaseIdentity(connection) {
  if (!env.isTest) return true;

  let rows;
  try {
    rows = await new Promise((resolve, reject) => {
      connection.query('SELECT DATABASE() AS databaseName, @@GLOBAL.server_uuid AS serverUuid', (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
    });
  } catch {
    discardRejectedConnection(connection);
    throw new Error('Test database identity verification failed; refusing database access');
  }

  const expectedServerUuid = normalizeMysqlServerUuid(env.testDatabaseServerUuid);
  const actualServerUuid = normalizeMysqlServerUuid(rows?.[0]?.serverUuid);
  if (
    env.db.name !== env.testDatabaseName
    || rows?.[0]?.databaseName !== env.testDatabaseName
    || !expectedServerUuid
    || !actualServerUuid
    || actualServerUuid !== expectedServerUuid
  ) {
    discardRejectedConnection(connection);
    throw new Error('Test database identity verification failed; refusing database access');
  }

  return true;
}

const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'mysql',
  timezone: '+00:00',
  logging: env.db.logging ? (msg) => logger.debug(msg) : false,
  define: {
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  pool: { max: 10, min: 0, idle: 10000, acquire: 30000 },
  hooks: { afterConnect: verifyTestDatabaseIdentity },
});

async function checkSchemaPreflight(seq = sequelize) {
  const queryInterface = seq.getQueryInterface();
  let table;
  let users;
  try {
    table = await queryInterface.describeTable('refresh_tokens');
    users = await queryInterface.describeTable('users');
  } catch {
    return false;
  }

  const hasFamilyId = table.family_id && !table.family_id.allowNull;
  const hasReplacedBy = Boolean(table.replaced_by_token_id);

  let hasIndexes = false;
  try {
    const rawIndexes = await queryInterface.showIndex('refresh_tokens');
    const indexNames = new Set(rawIndexes.map((idx) => idx.name));
    hasIndexes = indexNames.has('idx_rt_family') && indexNames.has('idx_rt_token_hash') && indexNames.has('idx_rt_replaced_by');
  } catch {
    hasIndexes = false;
  }

  if (!(hasFamilyId && hasReplacedBy && hasIndexes && users.token_version)) return false;
  return inspectReminderSchema(seq);
}

async function connectDb() {
  await sequelize.authenticate();
  logger.info(`Connected to MySQL database "${env.db.name}" at ${env.db.host}:${env.db.port}`);

  const isReady = await checkSchemaPreflight(sequelize);
  if (!isReady) {
    if (env.isProduction) {
      throw new Error('Database schema preflight failed: required session-security or reminder-storage schema is incomplete. Run "npm run db:migrate" before starting in production.');
    }
    logger.info('Schema incomplete in non-production environment. Executing advisory-locked migration...');
    const { migrate } = require('../migrations/run');
    await migrate(sequelize);
  }
}

module.exports = {
  sequelize,
  connectDb,
  checkSchemaPreflight,
  verifyTestDatabaseIdentity,
};
