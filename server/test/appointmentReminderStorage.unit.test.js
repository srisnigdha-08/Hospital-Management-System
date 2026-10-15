const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const contract = require('../src/migrations/reminderSchemaContract');

function describeDefinitions(definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, {
    type: typeof definition.type === 'string' ? definition.type : definition.type.toSql(),
    allowNull: Boolean(definition.allowNull),
    primaryKey: Boolean(definition.primaryKey),
    autoIncrement: Boolean(definition.autoIncrement),
    defaultValue: definition.defaultValue ?? null,
  }]));
}

function buildReadySchema() {
  return {
    tables: ['appointment_reminders', 'notifications'],
    columns: {
      appointment_reminders: describeDefinitions(contract.reminderColumnDefinitions()),
      notifications: describeDefinitions(contract.notificationColumnDefinitions()),
    },
    indexes: Object.fromEntries(['appointment_reminders', 'notifications'].map((table) => [
      table,
      contract.INDEXES.filter((index) => index.table === table).map((index) => ({
        name: index.name,
        unique: index.unique,
        fields: index.fields.map((attribute) => ({ attribute })),
      })),
    ])),
    foreignKeys: Object.fromEntries(['appointment_reminders', 'notifications'].map((table) => [
      table,
      contract.FOREIGN_KEYS.filter((foreignKey) => foreignKey.table === table).map((foreignKey) => ({
        constraintName: foreignKey.name,
        columnName: foreignKey.column,
        referencedSchema: 'hospital_management_test_fresh',
        currentSchema: 'hospital_management_test_fresh',
        referencedTable: foreignKey.referencedTable,
        referencedColumn: foreignKey.referencedColumn,
        deleteRule: foreignKey.onDelete,
        updateRule: foreignKey.onUpdate,
      })),
    ])),
    checks: contract.CHECKS.map((check) => ({ constraintName: check.name, checkClause: `(${check.expression})`, enforced: 'YES' })),
    notificationType: {
      columnType: "enum('appointment_booked','appointment_cancelled','appointment_reminder','appointment_rescheduled','system')",
      isNullable: 'NO',
      defaultValue: null,
      extra: '',
      columnComment: '',
      columnCollation: 'utf8mb4_0900_ai_ci',
      tableCollation: 'utf8mb4_0900_ai_ci',
    },
  };
}

function makePreflightSequence(schema) {
  return {
    getQueryInterface() {
      return {
        async showAllTables() { return schema.tables; },
        async describeTable(table) { return schema.columns[table]; },
        async showIndex(table) { return schema.indexes[table]; },
      };
    },
    async query(sql, options) {
      if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) return schema.foreignKeys[options.replacements.tableName];
      if (sql.includes('INFORMATION_SCHEMA.CHECK_CONSTRAINTS')) return schema.checks;
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [schema.notificationType];
      throw new Error('Unexpected query in database-free schema test');
    },
  };
}

function loadModelWithInMemorySequelize(relativePath) {
  const modelPath = require.resolve(relativePath);
  const sequelize = new Sequelize('unit-test', 'unit-test', 'unit-test', {
    dialect: 'mysql',
    timezone: '+00:00',
    logging: false,
  });
  const originalLoad = Module._load;
  Module._load = function loadModelStub(request, parent, isMain) {
    if (parent?.filename === modelPath && request === '../config/db') return { sequelize };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modelPath];
  try {
    return { model: require(modelPath), sequelize };
  } finally {
    Module._load = originalLoad;
  }
}

function createMigrationHarness({
  failOnceOnForeignKey = null,
  incompatibleExistingReminder = false,
  notificationType = "enum('appointment_booked','appointment_cancelled','appointment_rescheduled','system')",
  failAfterNotificationTypeChange = false,
  notificationColumnOverrides = {},
} = {}) {
  const existingReminderTables = incompatibleExistingReminder ? ['appointment_reminders'] : [];
  const schema = {
    tables: ['users', 'refresh_tokens', 'appointments', 'patients', 'notifications', ...existingReminderTables],
    columns: {
      users: { token_version: { type: 'INTEGER UNSIGNED', allowNull: false, defaultValue: 0 } },
      refresh_tokens: {
        family_id: { type: 'VARCHAR(64)', allowNull: false },
        replaced_by_token_id: { type: 'BIGINT UNSIGNED', allowNull: true },
        token_hash: { type: 'VARCHAR(255)', allowNull: false },
      },
      notifications: {
        notification_id: { type: 'BIGINT UNSIGNED', allowNull: false, primaryKey: true, autoIncrement: true },
        user_id: { type: 'BIGINT UNSIGNED', allowNull: false },
      },
      ...(incompatibleExistingReminder ? {
        appointment_reminders: {
          ...describeDefinitions(contract.reminderColumnDefinitions()),
          state: { ...describeDefinitions(contract.reminderColumnDefinitions()).state, type: 'VARCHAR(20)' },
        },
      } : {}),
    },
    indexes: {
      refresh_tokens: ['idx_rt_family', 'idx_rt_token_hash', 'idx_rt_replaced_by'].map((name) => ({
        name,
        unique: false,
        fields: [{ attribute: name === 'idx_rt_family' ? 'family_id' : name === 'idx_rt_token_hash' ? 'token_hash' : 'replaced_by_token_id' }],
      })),
      notifications: [],
      ...(incompatibleExistingReminder ? { appointment_reminders: [] } : {}),
    },
    foreignKeys: { appointment_reminders: [], notifications: [] },
    checks: [],
    notificationType: {
      columnType: notificationType,
      isNullable: 'NO',
      defaultValue: null,
      extra: '',
      columnComment: '',
      columnCollation: 'utf8mb4_0900_ai_ci',
      tableCollation: 'utf8mb4_0900_ai_ci',
      ...notificationColumnOverrides,
    },
  };
  const events = [];
  const addedIndexes = new Set();
  let failed = false;
  let failedNotificationTypeChange = false;

  const queryInterface = {
    async showAllTables() { return schema.tables; },
    async describeTable(table) {
      if (!schema.columns[table]) throw new Error(`Missing mocked table ${table}`);
      return schema.columns[table];
    },
    async showIndex(table) { return schema.indexes[table] || []; },
    async createTable(table, definitions) {
      events.push(`create:${table}`);
      schema.tables.push(table);
      schema.columns[table] = describeDefinitions(definitions);
      schema.indexes[table] = [];
      schema.foreignKeys[table] = [];
    },
    async addColumn(table, column, definition) {
      events.push(`column:${table}.${column}`);
      schema.columns[table][column] = describeDefinitions({ [column]: definition })[column];
    },
    async changeColumn(table, column, definition) {
      events.push(`change:${table}.${column}`);
      schema.notificationType.columnType = `enum(${definition.type.values.map((value) => `'${value}'`).join(',')})`;
      if (failAfterNotificationTypeChange && !failedNotificationTypeChange) {
        failedNotificationTypeChange = true;
        throw new Error('simulated interruption after notification enum DDL');
      }
    },
    async addIndex(table, fields, options) {
      events.push(`index:${options.name}`);
      schema.indexes[table].push({ name: options.name, unique: Boolean(options.unique), fields: fields.map((attribute) => ({ attribute })) });
      addedIndexes.add(options.name);
    },
    async addConstraint(table, options) {
      events.push(`constraint:${options.name}`);
      if (options.type === 'foreign key') {
        if (!failed && options.name === failOnceOnForeignKey) {
          failed = true;
          throw new Error('simulated interruption after additive DDL');
        }
        const foreignKey = contract.FOREIGN_KEYS.find((entry) => entry.name === options.name);
        schema.foreignKeys[table].push({
          constraintName: foreignKey.name,
          columnName: foreignKey.column,
          referencedSchema: 'hospital_management_test_fresh',
          currentSchema: 'hospital_management_test_fresh',
          referencedTable: foreignKey.referencedTable,
          referencedColumn: foreignKey.referencedColumn,
          deleteRule: foreignKey.onDelete,
          updateRule: foreignKey.onUpdate,
        });
      } else {
        const check = contract.CHECKS.find((entry) => entry.name === options.name);
        schema.checks.push({ constraintName: check.name, checkClause: check.expression, enforced: 'YES' });
      }
    },
  };

  const seq = {
    QueryTypes,
    connectionManager: {
      async getConnection() { events.push('connection'); return {}; },
      releaseConnection() { events.push('connection-release'); },
      async destroyConnection() { events.push('connection-destroy'); },
    },
    getQueryInterface() { return queryInterface; },
    async query(sql, options = {}) {
      if (sql.includes('GET_LOCK')) { events.push('lock-acquire'); return [{ lockAcquired: 1 }]; }
      if (sql.includes('RELEASE_LOCK')) { events.push('lock-release'); return [{ lockReleased: 1 }]; }
      if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) return schema.foreignKeys[options.replacements.tableName] || [];
      if (sql.includes('INFORMATION_SCHEMA.CHECK_CONSTRAINTS')) return schema.checks;
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [schema.notificationType];
      if (sql.startsWith('UPDATE refresh_tokens')) { events.push('legacy-migration-update'); return []; }
      if (sql.startsWith('SELECT 1')) return [];
      throw new Error(`Unexpected mocked query: ${sql}`);
    },
  };

  const runnerPath = require.resolve('../src/migrations/run');
  const originalLoad = Module._load;
  const fakeEnv = {
    nodeEnv: 'test',
    db: { name: 'hospital_management_test_fresh', user: 'synthetic_test_runner' },
    testDatabaseServerUuid: 'synthetic-test-server-uuid',
    validateDatabaseSettings() {},
  };
  Module._load = function loadWithDatabaseStubs(request, parent, isMain) {
    if (parent?.filename === runnerPath && request === '../config/env') return fakeEnv;
    if (parent?.filename === runnerPath && request === '../config/db') {
      return { sequelize: seq, verifyTestDatabaseIdentity: async () => { events.push('identity-check'); } };
    }
    if (parent?.filename === runnerPath && request === '../utils/logger') return { info() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[runnerPath];
  let migrationRunner;
  try {
    migrationRunner = require(runnerPath);
  } finally {
    Module._load = originalLoad;
  }

  return { schema, events, addedIndexes, seq, migrationRunner };
}

test('reminder schema preflight accepts exact columns, indexes, foreign keys, and checks', async () => {
  assert.equal(await contract.inspectReminderSchema(makePreflightSequence(buildReadySchema())), true);
});

test('notification type preflight accepts the reminder enum, reports the supported legacy enum incomplete, and rejects unknown shapes', async () => {
  const current = buildReadySchema();
  assert.equal(await contract.inspectReminderSchema(makePreflightSequence(current)), true);

  const legacy = buildReadySchema();
  legacy.notificationType.columnType = "enum('appointment_booked','appointment_cancelled','appointment_rescheduled','system')";
  assert.equal(await contract.inspectReminderSchema(makePreflightSequence(legacy)), false);

  const incompatible = buildReadySchema();
  incompatible.notificationType.columnType = "enum('appointment_booked','system')";
  await assert.rejects(contract.inspectReminderSchema(makePreflightSequence(incompatible)), contract.SchemaConflictError);
});

test('Sequelize reminder and notification model metadata matches the storage contract', () => {
  const reminder = loadModelWithInMemorySequelize('../src/models/AppointmentReminder.js');
  const notification = loadModelWithInMemorySequelize('../src/models/Notification.js');
  assert.equal(reminder.model.getTableName(), 'appointment_reminders');
  assert.equal(reminder.model.rawAttributes.appointmentId.field, 'appointment_id');
  assert.equal(reminder.model.rawAttributes.appointmentId.unique, 'uq_appointment_reminders_appointment');
  assert.equal(reminder.model.rawAttributes.attemptCount.validate.max, 5);
  assert.equal(reminder.model.rawAttributes.createdAt.field, 'created_at');
  assert.equal(reminder.model.rawAttributes.updatedAt.field, 'updated_at');
  assert.equal(notification.model.rawAttributes.appointmentReminderId.field, 'appointment_reminder_id');
  assert.equal(notification.model.rawAttributes.appointmentReminderId.unique, 'uq_notifications_appointment_reminder');
});

test('reminder schema preflight reports missing objects and rejects incompatible definitions', async () => {
  const missing = buildReadySchema();
  missing.indexes.notifications = [];
  assert.equal(await contract.inspectReminderSchema(makePreflightSequence(missing)), false);

  const incompatible = buildReadySchema();
  incompatible.columns.appointment_reminders.attempt_count.type = 'TINYINT';
  await assert.rejects(contract.inspectReminderSchema(makePreflightSequence(incompatible)), contract.SchemaConflictError);
});

test('schema contract rejects wrong index, foreign-key, and check definitions', () => {
  assert.throws(() => contract.inspectIndex([
    { name: 'uq_appointment_reminders_appointment', unique: false, fields: [{ attribute: 'patient_id' }] },
  ], contract.INDEXES[0]), contract.SchemaConflictError);
  assert.throws(() => contract.inspectForeignKey([
    { ...contract.FOREIGN_KEYS[0], columnName: 'appointment_id', referencedTable: 'patients', referencedColumn: 'patient_id' },
  ], contract.FOREIGN_KEYS[0]), contract.SchemaConflictError);
  assert.throws(() => contract.inspectCheck([
    { constraintName: contract.CHECKS[0].name, checkClause: 'attempt_count < 5' },
  ], contract.CHECKS[0]), contract.SchemaConflictError);
  assert.throws(() => contract.inspectCheck([
    { constraintName: contract.CHECKS[0].name, checkClause: contract.CHECKS[0].expression, enforced: 'NO' },
  ], contract.CHECKS[0]), contract.SchemaConflictError);
});

test('fresh-install bootstrap and general schema contain identical table definitions', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../../database/schema.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../database/test-bootstrap.sql'), 'utf8');
  const tableNames = (sql) => [...sql.matchAll(/^\s*CREATE TABLE\s+`?([a-z0-9_]+)/gim)].map((match) => match[1]).sort();
  const definitions = (sql) => [...sql.matchAll(/^\s*CREATE TABLE\s+`?([a-z0-9_]+)`?\s*\(([\s\S]*?)\)\s*ENGINE=InnoDB;/gim)]
    .map((match) => [match[1], match[2].replace(/--.*$/gm, '').replace(/\s+/g, ' ').replace(/,\s+/g, ',').trim()])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.equal(tableNames(schema).length, 19);
  assert.deepEqual(tableNames(bootstrap), tableNames(schema));
  assert.deepEqual(definitions(bootstrap), definitions(schema));
  assert.doesNotMatch(bootstrap, /\b(?:CREATE\s+DATABASE|USE\s+[a-z0-9_]+|DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i);
});

test('logical migration 003 runs only through migrate() under one advisory lock', async () => {
  const harness = createMigrationHarness();
  assert.deepEqual(Object.keys(harness.migrationRunner).sort(), ['migrate']);
  await harness.migrationRunner.migrate(harness.seq);
  const lockIndex = harness.events.indexOf('lock-acquire');
  const identityIndex = harness.events.indexOf('identity-check');
  const createIndex = harness.events.indexOf('create:appointment_reminders');
  const releaseIndex = harness.events.indexOf('lock-release');
  assert.ok(identityIndex >= 0 && lockIndex > identityIndex && createIndex > lockIndex && releaseIndex > createIndex);
  assert.equal(harness.events.filter((entry) => entry === 'lock-acquire').length, 1);
  assert.equal(harness.events.filter((entry) => entry === 'lock-release').length, 1);
  assert.equal(await contract.inspectReminderSchema(makePreflightSequence(harness.schema)), true);
});

test('migration 003 resumes after an interrupted additive constraint step', async () => {
  const harness = createMigrationHarness({ failOnceOnForeignKey: 'fk_appointment_reminders_patient' });
  await assert.rejects(harness.migrationRunner.migrate(harness.seq), /simulated interruption/);
  assert.ok(harness.events.includes('lock-release'));
  const createCount = harness.events.filter((entry) => entry === 'create:appointment_reminders').length;
  await harness.migrationRunner.migrate(harness.seq);
  assert.equal(harness.events.filter((entry) => entry === 'create:appointment_reminders').length, createCount);
  assert.equal(await contract.inspectReminderSchema(makePreflightSequence(harness.schema)), true);
  assert.ok(harness.addedIndexes.has('uq_appointment_reminders_appointment'));
});

test('migration 003 adds only the reminder enum value and resumes after the enum DDL was applied', async () => {
  const harness = createMigrationHarness({ failAfterNotificationTypeChange: true });
  await assert.rejects(harness.migrationRunner.migrate(harness.seq), /simulated interruption after notification enum DDL/);
  assert.deepEqual(contract.parseMysqlEnumValues(harness.schema.notificationType.columnType), [
    'appointment_booked',
    'appointment_cancelled',
    'appointment_rescheduled',
    'system',
    'appointment_reminder',
  ]);
  assert.ok(harness.events.includes('lock-release'));

  await harness.migrationRunner.migrate(harness.seq);
  assert.equal(harness.events.filter((entry) => entry === 'change:notifications.type').length, 1);
  assert.equal(await contract.inspectReminderSchema(makePreflightSequence(harness.schema)), true);
});

test('migration 003 does not alter an already-compatible notification enum', async () => {
  const harness = createMigrationHarness({
    notificationType: "enum('appointment_booked','appointment_cancelled','appointment_reminder','appointment_rescheduled','system')",
  });
  await harness.migrationRunner.migrate(harness.seq);
  assert.equal(harness.events.some((entry) => entry === 'change:notifications.type'), false);
});

test('migration 003 refuses unknown notification enum values before reminder DDL', async () => {
  const harness = createMigrationHarness({
    notificationType: "enum('appointment_booked','appointment_cancelled','appointment_reminder','appointment_rescheduled','system','custom')",
  });
  await assert.rejects(harness.migrationRunner.migrate(harness.seq), /unknown ENUM definition/);
  assert.equal(harness.events.some((entry) => /^(create|column|index|constraint|change):/.test(entry)), false);
});

test('migration 003 refuses a legacy enum whose column collation would be changed', async () => {
  const harness = createMigrationHarness({ notificationColumnOverrides: { columnCollation: 'utf8mb4_bin' } });
  await assert.rejects(harness.migrationRunner.migrate(harness.seq), /custom attributes/);
  assert.equal(harness.events.some((entry) => entry === 'change:notifications.type'), false);
});

test('migration 003 refuses an incompatible existing table before reminder DDL', async () => {
  const harness = createMigrationHarness({ incompatibleExistingReminder: true });
  await assert.rejects(harness.migrationRunner.migrate(harness.seq), /incompatible definition/);
  assert.equal(harness.events.some((entry) => /^(create|column|index|constraint):/.test(entry)), false);
});

test('database startup preflight includes the complete reminder schema contract', async () => {
  const schema = buildReadySchema();
  const preflightSeq = makePreflightSequence(schema);
  const originalGetQueryInterface = preflightSeq.getQueryInterface;
  preflightSeq.getQueryInterface = () => {
    const queryInterface = originalGetQueryInterface();
    return {
      ...queryInterface,
      async describeTable(table) {
        if (table === 'refresh_tokens') return { family_id: { allowNull: false }, replaced_by_token_id: {} };
        if (table === 'users') return { token_version: {} };
        return queryInterface.describeTable(table);
      },
      async showIndex(table) {
        if (table === 'refresh_tokens') return ['idx_rt_family', 'idx_rt_token_hash', 'idx_rt_replaced_by'].map((name) => ({ name }));
        return queryInterface.showIndex(table);
      },
    };
  };

  const dbPath = require.resolve('../src/config/db');
  const originalLoad = Module._load;
  const fakeEnv = { isTest: false, isProduction: false, db: { name: 'unit-test', user: 'unit-test', password: '', host: 'unit-test', port: 3306, logging: false } };
  Module._load = function loadDatabaseStubs(request, parent, isMain) {
    if (parent?.filename === dbPath && request === 'sequelize') return { Sequelize: function MockSequelize() { return preflightSeq; } };
    if (parent?.filename === dbPath && request === './env') return fakeEnv;
    if (parent?.filename === dbPath && request === '../utils/logger') return { info() {}, debug() {} };
    if (parent?.filename === dbPath && request === './testDatabaseIdentity') return { normalizeMysqlServerUuid: () => null };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[dbPath];
  let databaseConfig;
  try {
    databaseConfig = require(dbPath);
  } finally {
    Module._load = originalLoad;
  }

  assert.equal(await databaseConfig.checkSchemaPreflight(preflightSeq), true);
  schema.checks = [];
  assert.equal(await databaseConfig.checkSchemaPreflight(preflightSeq), false);
  delete require.cache[dbPath];
});
