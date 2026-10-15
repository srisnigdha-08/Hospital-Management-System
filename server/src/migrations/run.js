const env = require('../config/env');
const { DataTypes, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const reminderSchema = require('./reminderSchemaContract');

const TEST_DATABASE_NAME = 'hospital_management_test_fresh';

if (require.main === module) {
  if (!process.env.NODE_ENV) {
    console.error('Migration command requires an explicit NODE_ENV; refusing to use the development default.');
    process.exit(1);
  }
  env.validateDatabaseSettings({
    nodeEnv: env.nodeEnv,
    dbName: env.db.name,
    dbUser: env.db.user,
    testDbServerUuid: env.testDatabaseServerUuid,
  });
}

const { sequelize, verifyTestDatabaseIdentity } = require('../config/db');

async function migrateRefreshTokenFamilies(seq) {
  const queryInterface = seq.getQueryInterface();
  const table = await queryInterface.describeTable('refresh_tokens');

  if (!table.family_id) {
    logger.info('Adding family_id column (nullable)...');
    await queryInterface.addColumn('refresh_tokens', 'family_id', {
      type: DataTypes.STRING(64),
      allowNull: true,
      after: 'user_id',
    });
  }

  if (!table.replaced_by_token_id) {
    logger.info('Adding replaced_by_token_id column (nullable)...');
    await queryInterface.addColumn('refresh_tokens', 'replaced_by_token_id', {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      after: 'created_by_ip',
    });
  }

  logger.info('Backfilling NULL family_id values with unique UUIDs...');
  await seq.query('UPDATE refresh_tokens SET family_id = UUID() WHERE family_id IS NULL');

  const updatedTable = await queryInterface.describeTable('refresh_tokens');
  if (updatedTable.family_id && updatedTable.family_id.allowNull) {
    logger.info('Enforcing NOT NULL constraint on family_id...');
    await queryInterface.changeColumn('refresh_tokens', 'family_id', {
      type: DataTypes.STRING(64),
      allowNull: false,
    });
  }

  const rawIndexes = await queryInterface.showIndex('refresh_tokens');
  const existingIndexNames = new Set(rawIndexes.map((idx) => idx.name));
  if (!existingIndexNames.has('idx_rt_family')) {
    logger.info('Creating index idx_rt_family...');
    await queryInterface.addIndex('refresh_tokens', ['family_id'], { name: 'idx_rt_family' });
  }
  if (!existingIndexNames.has('idx_rt_token_hash')) {
    logger.info('Creating index idx_rt_token_hash...');
    await queryInterface.addIndex('refresh_tokens', ['token_hash'], { name: 'idx_rt_token_hash' });
  }
  if (!existingIndexNames.has('idx_rt_replaced_by')) {
    logger.info('Creating index idx_rt_replaced_by...');
    await queryInterface.addIndex('refresh_tokens', ['replaced_by_token_id'], { name: 'idx_rt_replaced_by' });
  }

  logger.info('Migration 001_add_refresh_token_families completed successfully.');
}

async function migrateUserTokenVersion(seq) {
  const queryInterface = seq.getQueryInterface();
  const users = await queryInterface.describeTable('users');
  if (!users.token_version) {
    await queryInterface.addColumn('users', 'token_version', {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
  }
}

async function assertNoRows(seq, sql, description) {
  const rows = await seq.query(sql, { type: seq.QueryTypes.SELECT });
  if (rows.length) throw new Error(`Migration 003 stopped: ${description}; review existing data before retrying`);
}

async function ensureIndex(seq, index) {
  const queryInterface = seq.getQueryInterface();
  const indexes = await queryInterface.showIndex(index.table);
  if (reminderSchema.inspectIndex(indexes, index)) return;
  await queryInterface.addIndex(index.table, index.fields, { name: index.name, unique: index.unique });
}

async function ensureForeignKey(seq, foreignKey) {
  const queryInterface = seq.getQueryInterface();
  const rows = await reminderSchema.readForeignKeys(seq, foreignKey.table);
  if (reminderSchema.inspectForeignKey(rows, foreignKey)) return;
  await queryInterface.addConstraint(foreignKey.table, {
    fields: [foreignKey.column],
    type: 'foreign key',
    name: foreignKey.name,
    references: { table: foreignKey.referencedTable, field: foreignKey.referencedColumn },
    onDelete: foreignKey.onDelete,
    onUpdate: foreignKey.onUpdate,
  });
}

async function ensureCheck(seq, check) {
  const queryInterface = seq.getQueryInterface();
  const rows = await reminderSchema.readChecks(seq, check.table);
  if (reminderSchema.inspectCheck(rows, check)) return;
  await queryInterface.addConstraint(check.table, {
    fields: check.table === reminderSchema.REMINDER_TABLE ? ['attempt_count'] : [],
    type: 'check',
    name: check.name,
    where: Sequelize.literal(check.expression),
  });
}

async function ensureAppointmentReminderNotificationType(seq, queryInterface) {
  const column = await reminderSchema.readNotificationTypeColumn(seq);
  const contract = reminderSchema.inspectNotificationTypeColumn(column);
  if (!contract.needsAppointmentReminder) return;

  const definition = {
    type: DataTypes.ENUM(...contract.values, 'appointment_reminder'),
    allowNull: false,
  };
  if (column.defaultValue !== null && column.defaultValue !== undefined) {
    definition.defaultValue = column.defaultValue;
  }
  await queryInterface.changeColumn(reminderSchema.NOTIFICATION_TABLE, 'type', definition);

  const upgraded = reminderSchema.inspectNotificationTypeColumn(await reminderSchema.readNotificationTypeColumn(seq));
  if (!upgraded.supportsAppointmentReminder) {
    throw new reminderSchema.SchemaConflictError('notifications.type upgrade did not add appointment_reminder');
  }
}

async function validateReminderData(seq, indexes, foreignKeys) {
  const missingUnique = indexes.filter((index) => index.unique);
  for (const index of missingUnique) {
    const [field] = index.fields;
    await assertNoRows(
      seq,
      `SELECT 1 FROM ${index.table} WHERE ${field} IS NOT NULL GROUP BY ${field} HAVING COUNT(*) > 1 LIMIT 1`,
      `duplicate values conflict with ${index.name}`
    );
  }

  for (const foreignKey of foreignKeys) {
    const childAlias = foreignKey.table === reminderSchema.REMINDER_TABLE ? 'r' : 'n';
    const parentAlias = foreignKey.referencedTable === 'appointments' ? 'a'
      : foreignKey.referencedTable === 'patients' ? 'p' : 'r';
    await assertNoRows(
      seq,
      `SELECT 1 FROM ${foreignKey.table} ${childAlias}
       LEFT JOIN ${foreignKey.referencedTable} ${parentAlias}
         ON ${parentAlias}.${foreignKey.referencedColumn} = ${childAlias}.${foreignKey.column}
       WHERE ${childAlias}.${foreignKey.column} IS NOT NULL AND ${parentAlias}.${foreignKey.referencedColumn} IS NULL LIMIT 1`,
      `orphaned values conflict with ${foreignKey.name}`
    );
  }

  await assertNoRows(
    seq,
    `SELECT 1 FROM appointment_reminders r
      JOIN appointments a ON a.appointment_id = r.appointment_id
     WHERE a.patient_id <> r.patient_id LIMIT 1`,
    'a reminder recipient does not match its appointment patient'
  );
  await assertNoRows(
    seq,
    `SELECT 1 FROM notifications n
      JOIN appointment_reminders r ON r.appointment_reminder_id = n.appointment_reminder_id
      JOIN patients p ON p.patient_id = r.patient_id
     WHERE n.user_id <> p.user_id LIMIT 1`,
    'a linked notification recipient does not match its reminder patient'
  );
  await assertNoRows(
    seq,
    'SELECT 1 FROM appointment_reminders WHERE attempt_count > 5 LIMIT 1',
    'an attempt count exceeds the supported maximum'
  );
  await assertNoRows(
    seq,
    `SELECT 1 FROM appointment_reminders
      WHERE NOT ((claim_token IS NULL AND lease_expires_at_utc IS NULL)
        OR (claim_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)) LIMIT 1`,
    'claim token and lease expiry are inconsistent'
  );
}

async function migrateAppointmentReminderStorage(seq) {
  const queryInterface = seq.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const existingTables = new Set(tables.map((entry) => String(typeof entry === 'string' ? entry : entry.tableName).toLowerCase()));
  for (const required of ['appointments', 'patients', reminderSchema.NOTIFICATION_TABLE]) {
    if (!existingTables.has(required)) throw new Error(`Migration 003 requires the existing ${required} table`);
  }

  await ensureAppointmentReminderNotificationType(seq, queryInterface);

  const reminderTableExists = existingTables.has(reminderSchema.REMINDER_TABLE);
  const notificationDefinitions = reminderSchema.notificationColumnDefinitions();
  let notificationColumns = await queryInterface.describeTable(reminderSchema.NOTIFICATION_TABLE);
  reminderSchema.assertColumnsCompatible(notificationColumns, notificationDefinitions, reminderSchema.NOTIFICATION_TABLE);
  const existingNotificationIndexes = await queryInterface.showIndex(reminderSchema.NOTIFICATION_TABLE);
  for (const index of reminderSchema.INDEXES.filter((entry) => entry.table === reminderSchema.NOTIFICATION_TABLE)) {
    reminderSchema.inspectIndex(existingNotificationIndexes, index);
  }
  const existingNotificationFks = await reminderSchema.readForeignKeys(seq, reminderSchema.NOTIFICATION_TABLE);
  for (const foreignKey of reminderSchema.FOREIGN_KEYS.filter((entry) => entry.table === reminderSchema.NOTIFICATION_TABLE)) {
    reminderSchema.inspectForeignKey(existingNotificationFks, foreignKey);
  }

  if (reminderTableExists) {
    const existing = await queryInterface.describeTable(reminderSchema.REMINDER_TABLE);
    const missing = reminderSchema.assertColumnsCompatible(
      existing,
      reminderSchema.reminderColumnDefinitions(),
      reminderSchema.REMINDER_TABLE
    );
    if (missing.length) {
      throw new reminderSchema.SchemaConflictError(`${reminderSchema.REMINDER_TABLE} is missing required columns: ${missing.join(', ')}`);
    }
  }

  if (reminderTableExists) {
    for (const index of reminderSchema.INDEXES.filter((entry) => entry.table === reminderSchema.REMINDER_TABLE)) {
      reminderSchema.inspectIndex(await queryInterface.showIndex(reminderSchema.REMINDER_TABLE), index);
    }
    const existingReminderFks = await reminderSchema.readForeignKeys(seq, reminderSchema.REMINDER_TABLE);
    for (const foreignKey of reminderSchema.FOREIGN_KEYS.filter((entry) => entry.table === reminderSchema.REMINDER_TABLE)) {
      reminderSchema.inspectForeignKey(existingReminderFks, foreignKey);
    }
    const existingChecks = await reminderSchema.readChecks(seq, reminderSchema.REMINDER_TABLE);
    for (const check of reminderSchema.CHECKS) reminderSchema.inspectCheck(existingChecks, check);
  }

  if (!reminderTableExists) {
    await queryInterface.createTable(reminderSchema.REMINDER_TABLE, reminderSchema.reminderColumnDefinitions());
  }

  const missingNotificationColumns = reminderSchema.assertColumnsCompatible(
    notificationColumns,
    notificationDefinitions,
    reminderSchema.NOTIFICATION_TABLE
  );
  for (const columnName of missingNotificationColumns) {
    await queryInterface.addColumn(reminderSchema.NOTIFICATION_TABLE, columnName, notificationDefinitions[columnName]);
    notificationColumns = await queryInterface.describeTable(reminderSchema.NOTIFICATION_TABLE);
  }

  const currentIndexes = new Map();
  for (const tableName of [reminderSchema.REMINDER_TABLE, reminderSchema.NOTIFICATION_TABLE]) {
    currentIndexes.set(tableName, await queryInterface.showIndex(tableName));
  }
  const missingIndexes = reminderSchema.INDEXES.filter((index) => !reminderSchema.inspectIndex(currentIndexes.get(index.table), index));
  const foreignKeyRows = new Map();
  for (const tableName of [reminderSchema.REMINDER_TABLE, reminderSchema.NOTIFICATION_TABLE]) {
    foreignKeyRows.set(tableName, await reminderSchema.readForeignKeys(seq, tableName));
  }
  const missingForeignKeys = reminderSchema.FOREIGN_KEYS.filter((foreignKey) =>
    !reminderSchema.inspectForeignKey(foreignKeyRows.get(foreignKey.table), foreignKey));
  const checkRows = await reminderSchema.readChecks(seq, reminderSchema.REMINDER_TABLE);
  const missingChecks = reminderSchema.CHECKS.filter((check) => !reminderSchema.inspectCheck(checkRows, check));

  await validateReminderData(seq, missingIndexes, missingForeignKeys);

  for (const index of missingIndexes) await ensureIndex(seq, index);
  for (const foreignKey of missingForeignKeys) await ensureForeignKey(seq, foreignKey);
  for (const check of missingChecks) await ensureCheck(seq, check);

  const ready = await reminderSchema.inspectReminderSchema(seq);
  if (!ready) throw new Error('Migration 003 completed DDL but the required reminder schema is still incomplete');
  logger.info('Migration 003 appointment reminder storage completed successfully.');
}

async function applyMigrations(seq) {
  await migrateRefreshTokenFamilies(seq);
  await migrateUserTokenVersion(seq);
  await migrateAppointmentReminderStorage(seq);
}

async function migrate(seq = sequelize) {
  env.validateDatabaseSettings({
    nodeEnv: env.nodeEnv,
    dbName: env.db.name,
    dbUser: env.db.user,
    testDbServerUuid: env.testDatabaseServerUuid,
  });
  const connection = await seq.connectionManager.getConnection();
  let lockState = 'not-acquired';
  let connectionMustBeDestroyed = false;
  let operationError;
  let cleanupError;

  try {
    try {
      await verifyTestDatabaseIdentity(connection);
    } catch (error) {
      connectionMustBeDestroyed = true;
      throw error;
    }

    lockState = 'uncertain';
    let lockRows;
    try {
      [lockRows] = await seq.query("SELECT GET_LOCK('hms_migration_lock', 10) AS lockAcquired", {
        type: seq.QueryTypes.SELECT,
        connection,
      });
    } catch (error) {
      connectionMustBeDestroyed = true;
      throw error;
    }
    if (!lockRows || lockRows.lockAcquired !== 1) {
      connectionMustBeDestroyed = true;
      throw new Error('Failed to acquire migration advisory lock; lock ownership is uncertain');
    }

    lockState = 'acquired';
    await applyMigrations(seq);
  } catch (error) {
    operationError = error;
  }

  if (lockState === 'acquired') {
    try {
      const [releaseRows] = await seq.query("SELECT RELEASE_LOCK('hms_migration_lock') AS lockReleased", {
        type: seq.QueryTypes.SELECT,
        connection,
      });
      if (!releaseRows || releaseRows.lockReleased !== 1) {
        throw new Error('Failed to confirm release of the migration advisory lock');
      }
      lockState = 'released';
    } catch (error) {
      connectionMustBeDestroyed = true;
      cleanupError = error;
    }
  }

  if (connectionMustBeDestroyed) {
    try {
      await seq.connectionManager.destroyConnection(connection);
    } catch (error) {
      try {
        connection.destroy?.();
      } catch (fallbackError) {
        cleanupError = cleanupError
          ? new AggregateError([cleanupError, error, fallbackError], 'Migration connection cleanup failed')
          : new AggregateError([error, fallbackError], 'Migration connection cleanup failed');
      }
      if (!cleanupError) cleanupError = error;
      else if (!(cleanupError instanceof AggregateError)) {
        cleanupError = new AggregateError([cleanupError, error], 'Migration connection cleanup failed');
      }
    }
  } else {
    try {
      seq.connectionManager.releaseConnection(connection);
    } catch (error) {
      cleanupError = error;
      try {
        await seq.connectionManager.destroyConnection(connection);
      } catch (destroyError) {
        try {
          connection.destroy?.();
        } catch (fallbackError) {
          cleanupError = new AggregateError([error, destroyError, fallbackError], 'Migration connection cleanup failed');
        }
        if (!(cleanupError instanceof AggregateError)) {
          cleanupError = new AggregateError([error, destroyError], 'Migration connection cleanup failed');
        }
      }
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'Migration failed and connection cleanup also failed',
      { cause: operationError },
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}

if (require.main === module) {
  migrate()
    .then(async () => {
      console.log('Migrations finished successfully.');
      await sequelize.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      await sequelize.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrate };
