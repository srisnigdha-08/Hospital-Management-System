const { DataTypes, QueryTypes } = require('sequelize');

const REMINDER_TABLE = 'appointment_reminders';
const NOTIFICATION_TABLE = 'notifications';
const NOTIFICATION_TYPE_VALUES = Object.freeze([
  'appointment_booked',
  'appointment_cancelled',
  'appointment_reminder',
  'appointment_rescheduled',
  'system',
]);
const LEGACY_NOTIFICATION_TYPE_VALUES = Object.freeze([
  'appointment_booked',
  'appointment_cancelled',
  'appointment_rescheduled',
  'system',
]);

function reminderColumnDefinitions() {
  return {
    appointment_reminder_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, primaryKey: true, autoIncrement: true },
    appointment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patient_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    idempotency_key: { type: DataTypes.STRING(96), allowNull: false },
    scheduled_start_utc: { type: DataTypes.DATE(3), allowNull: false },
    due_at_utc: { type: DataTypes.DATE(3), allowNull: false },
    next_attempt_at_utc: { type: DataTypes.DATE(3), allowNull: false },
    schedule_revision: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    state: {
      type: DataTypes.ENUM('pending', 'delivered', 'cancelled', 'skipped', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    attempt_count: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    claim_token: { type: DataTypes.STRING(36), allowNull: true },
    lease_expires_at_utc: { type: DataTypes.DATE(3), allowNull: true },
    last_attempt_at_utc: { type: DataTypes.DATE(3), allowNull: true },
    delivered_at_utc: { type: DataTypes.DATE(3), allowNull: true },
    outcome_code: { type: DataTypes.STRING(64), allowNull: true },
    created_at: { type: DataTypes.DATE(3), allowNull: false },
    updated_at: { type: DataTypes.DATE(3), allowNull: false },
  };
}

function notificationColumnDefinitions() {
  return {
    appointment_reminder_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    reminder_scheduled_start_utc: { type: DataTypes.DATE(3), allowNull: true },
  };
}

const INDEXES = Object.freeze([
  { table: REMINDER_TABLE, name: 'uq_appointment_reminders_appointment', fields: ['appointment_id'], unique: true },
  { table: REMINDER_TABLE, name: 'uq_appointment_reminders_idempotency', fields: ['idempotency_key'], unique: true },
  { table: REMINDER_TABLE, name: 'idx_appointment_reminders_due', fields: ['state', 'next_attempt_at_utc', 'appointment_reminder_id'], unique: false },
  { table: REMINDER_TABLE, name: 'idx_appointment_reminders_lease', fields: ['state', 'lease_expires_at_utc', 'appointment_reminder_id'], unique: false },
  { table: REMINDER_TABLE, name: 'idx_appointment_reminders_patient', fields: ['patient_id'], unique: false },
  { table: NOTIFICATION_TABLE, name: 'uq_notifications_appointment_reminder', fields: ['appointment_reminder_id'], unique: true },
]);

const FOREIGN_KEYS = Object.freeze([
  {
    table: REMINDER_TABLE,
    name: 'fk_appointment_reminders_appointment',
    column: 'appointment_id',
    referencedTable: 'appointments',
    referencedColumn: 'appointment_id',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  },
  {
    table: REMINDER_TABLE,
    name: 'fk_appointment_reminders_patient',
    column: 'patient_id',
    referencedTable: 'patients',
    referencedColumn: 'patient_id',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  },
  {
    table: NOTIFICATION_TABLE,
    name: 'fk_notifications_appointment_reminder',
    column: 'appointment_reminder_id',
    referencedTable: REMINDER_TABLE,
    referencedColumn: 'appointment_reminder_id',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  },
]);

const CHECKS = Object.freeze([
  {
    table: REMINDER_TABLE,
    name: 'chk_appointment_reminders_attempt_count',
    expression: 'attempt_count <= 5',
  },
  {
    table: REMINDER_TABLE,
    name: 'chk_appointment_reminders_claim_pair',
    expression: '(claim_token IS NULL AND lease_expires_at_utc IS NULL) OR (claim_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)',
  },
]);

class SchemaConflictError extends Error {
  constructor(message) {
    super(`Reminder schema conflict: ${message}`);
    this.name = 'SchemaConflictError';
  }
}

function parseMysqlEnumValues(columnType) {
  const match = /^enum\s*\(([\s\S]*)\)$/i.exec(String(columnType ?? '').trim());
  if (!match) throw new SchemaConflictError('notifications.type is not a recognized ENUM definition');

  const source = match[1];
  const values = [];
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[index] || '')) index += 1;
  };

  while (index < source.length) {
    skipWhitespace();
    if (source[index] !== "'") throw new SchemaConflictError('notifications.type contains an unrecognized ENUM value');
    index += 1;
    let value = '';
    let closed = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (character === "'") {
        if (source[index] === "'") {
          value += "'";
          index += 1;
        } else {
          closed = true;
          break;
        }
      } else if (character === '\\') {
        if (index >= source.length) throw new SchemaConflictError('notifications.type has an incomplete ENUM escape');
        const escaped = source[index];
        index += 1;
        const escapes = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', '\\': '\\', "'": "'", '"': '"' };
        if (!Object.hasOwn(escapes, escaped)) throw new SchemaConflictError('notifications.type has an unsupported ENUM escape');
        value += escapes[escaped];
      } else {
        value += character;
      }
    }
    if (!closed) throw new SchemaConflictError('notifications.type has an unterminated ENUM value');
    values.push(value);
    skipWhitespace();
    if (index === source.length) break;
    if (source[index] !== ',') throw new SchemaConflictError('notifications.type has an invalid ENUM separator');
    index += 1;
  }

  if (!values.length || new Set(values).size !== values.length) {
    throw new SchemaConflictError('notifications.type has an empty or duplicate ENUM definition');
  }
  return values;
}

function inspectNotificationTypeColumn(column) {
  if (!column || String(column.isNullable).toUpperCase() !== 'NO' || String(column.extra ?? '') !== '') {
    throw new SchemaConflictError('notifications.type has incompatible nullability or column attributes');
  }
  const values = parseMysqlEnumValues(column.columnType);
  const existingOrder = values.filter((value) => value !== 'appointment_reminder');
  const hasReminderType = values.includes('appointment_reminder');
  const existingValuesPreserved = existingOrder.length === LEGACY_NOTIFICATION_TYPE_VALUES.length
    && existingOrder.every((value, index) => value === LEGACY_NOTIFICATION_TYPE_VALUES[index]);
  const isCurrent = hasReminderType
    && existingValuesPreserved
    && values.length === NOTIFICATION_TYPE_VALUES.length;
  const isLegacy = values.length === LEGACY_NOTIFICATION_TYPE_VALUES.length
    && values.every((value, index) => value === LEGACY_NOTIFICATION_TYPE_VALUES[index]);
  if (!isCurrent && !isLegacy) {
    throw new SchemaConflictError('notifications.type has an unknown ENUM definition; review it before migration');
  }
  if (column.defaultValue !== null && column.defaultValue !== undefined && !values.includes(String(column.defaultValue))) {
    throw new SchemaConflictError('notifications.type has a default outside its ENUM values');
  }
  if (isLegacy && (
    String(column.columnComment ?? '') !== ''
    || !column.columnCollation
    || !column.tableCollation
    || String(column.columnCollation).toLowerCase() !== String(column.tableCollation).toLowerCase()
  )) {
    throw new SchemaConflictError('notifications.type has custom attributes that cannot be preserved safely');
  }
  return { values, supportsAppointmentReminder: isCurrent, needsAppointmentReminder: isLegacy };
}

async function readNotificationTypeColumn(seq) {
  const rows = await seq.query(
    `SELECT c.COLUMN_TYPE AS columnType, c.IS_NULLABLE AS isNullable,
            c.COLUMN_DEFAULT AS defaultValue, c.EXTRA AS extra,
            c.COLUMN_COMMENT AS columnComment, c.COLLATION_NAME AS columnCollation,
            t.TABLE_COLLATION AS tableCollation
       FROM INFORMATION_SCHEMA.COLUMNS c
       JOIN INFORMATION_SCHEMA.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = :tableName AND c.COLUMN_NAME = 'type'`,
    { type: QueryTypes.SELECT, replacements: { tableName: NOTIFICATION_TABLE } }
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new SchemaConflictError('notifications.type metadata is missing or ambiguous');
  }
  return rows[0];
}

function normalizeType(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '');
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

function columnType(definition) {
  return typeof definition.type === 'string' ? definition.type : definition.type.toSql();
}

function assertColumnsCompatible(actual, expected, label) {
  const missing = [];
  for (const [name, definition] of Object.entries(expected)) {
    const column = actual?.[name];
    if (!column) {
      missing.push(name);
      continue;
    }
    const compatible = normalizeType(column.type) === normalizeType(columnType(definition))
      && Boolean(column.allowNull) === Boolean(definition.allowNull)
      && Boolean(column.primaryKey) === Boolean(definition.primaryKey)
      && Boolean(column.autoIncrement) === Boolean(definition.autoIncrement)
      && normalizeDefault(column.defaultValue) === normalizeDefault(definition.defaultValue);
    if (!compatible) throw new SchemaConflictError(`${label}.${name} has an incompatible definition`);
  }
  return missing;
}

function normalizedFields(index) {
  return (index.fields || []).map((field) => String(field.attribute || field.name || field).toLowerCase());
}

function inspectIndex(indexes, expected) {
  const matchingName = indexes.find((index) => index.name === expected.name);
  const isCompatible = (index) => Boolean(index.unique) === expected.unique
    && normalizedFields(index).join(',') === expected.fields.join(',')
    && (index.fields || []).every((field) => typeof field === 'string' || field.length === null || field.length === undefined);
  if (matchingName) {
    if (!isCompatible(matchingName)) throw new SchemaConflictError(`index ${expected.table}.${expected.name} has an incompatible definition`);
    return true;
  }
  const equivalent = indexes.find(isCompatible);
  if (equivalent) throw new SchemaConflictError(`equivalent index ${expected.table}.${equivalent.name} exists under an unexpected name`);
  return false;
}

function inspectForeignKey(rows, expected) {
  const candidates = rows.filter((row) => String(row.columnName).toLowerCase() === expected.column);
  const matchingName = candidates.find((row) => row.constraintName === expected.name);
  const isCompatible = (row) => String(row.referencedTable).toLowerCase() === expected.referencedTable
    && String(row.referencedColumn).toLowerCase() === expected.referencedColumn
    && String(row.referencedSchema).toLowerCase() === String(row.currentSchema).toLowerCase()
    && String(row.deleteRule).toUpperCase() === expected.onDelete
    && String(row.updateRule).toUpperCase() === expected.onUpdate;
  if (matchingName) {
    if (candidates.filter((row) => row.constraintName === expected.name).length !== 1 || !isCompatible(matchingName)) {
      throw new SchemaConflictError(`foreign key ${expected.table}.${expected.name} has an incompatible definition`);
    }
    return true;
  }
  if (candidates.length) throw new SchemaConflictError(`foreign key on ${expected.table}.${expected.column} exists under an unexpected or incompatible definition`);
  return false;
}

function normalizeCheck(expression) {
  let normalized = String(expression ?? '').toLowerCase().replace(/`/g, '').replace(/\s+/g, '');
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] === '(') depth += 1;
      if (normalized[index] === ')') depth -= 1;
      if (depth === 0 && index < normalized.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function inspectCheck(rows, expected) {
  const matchingName = rows.find((row) => row.constraintName === expected.name);
  if (matchingName) {
    const enforced = ['YES', '1', 'TRUE'].includes(String(matchingName.enforced).toUpperCase());
    if (!enforced || normalizeCheck(matchingName.checkClause) !== normalizeCheck(expected.expression)) {
      throw new SchemaConflictError(`check constraint ${expected.table}.${expected.name} has an incompatible definition`);
    }
    return true;
  }
  if (rows.some((row) => normalizeCheck(row.checkClause) === normalizeCheck(expected.expression))) {
    throw new SchemaConflictError(`equivalent check constraint on ${expected.table} exists under an unexpected name`);
  }
  return false;
}

async function readForeignKeys(seq, tableName) {
  return seq.query(
    `SELECT DATABASE() AS currentSchema, k.REFERENCED_TABLE_SCHEMA AS referencedSchema,
            k.CONSTRAINT_NAME AS constraintName, k.COLUMN_NAME AS columnName,
            k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn,
            r.DELETE_RULE AS deleteRule, r.UPDATE_RULE AS updateRule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
       JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
         ON t.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND t.TABLE_NAME = k.TABLE_NAME
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = :tableName
        AND t.CONSTRAINT_TYPE = 'FOREIGN KEY' AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    { type: QueryTypes.SELECT, replacements: { tableName } }
  );
}

async function readChecks(seq, tableName) {
  return seq.query(
    `SELECT t.CONSTRAINT_NAME AS constraintName, c.CHECK_CLAUSE AS checkClause,
            t.ENFORCED AS enforced
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
       JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS c
         ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
      WHERE t.CONSTRAINT_SCHEMA = DATABASE() AND t.TABLE_NAME = :tableName
        AND t.CONSTRAINT_TYPE = 'CHECK'`,
    { type: QueryTypes.SELECT, replacements: { tableName } }
  );
}

function tableExists(tables, target) {
  return tables.some((entry) => String(typeof entry === 'string' ? entry : entry.tableName).toLowerCase() === target);
}

async function inspectReminderSchema(seq) {
  const queryInterface = seq.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  if (!tableExists(tables, REMINDER_TABLE) || !tableExists(tables, NOTIFICATION_TABLE)) return false;

  const [reminderColumns, notificationColumns] = await Promise.all([
    queryInterface.describeTable(REMINDER_TABLE),
    queryInterface.describeTable(NOTIFICATION_TABLE),
  ]);
  const missingColumns = [
    ...assertColumnsCompatible(reminderColumns, reminderColumnDefinitions(), REMINDER_TABLE),
    ...assertColumnsCompatible(notificationColumns, notificationColumnDefinitions(), NOTIFICATION_TABLE),
  ];
  if (missingColumns.length) return false;
  const notificationType = inspectNotificationTypeColumn(await readNotificationTypeColumn(seq));
  if (!notificationType.supportsAppointmentReminder) return false;

  const [reminderIndexes, notificationIndexes, reminderForeignKeys, notificationForeignKeys, reminderChecks] = await Promise.all([
    queryInterface.showIndex(REMINDER_TABLE),
    queryInterface.showIndex(NOTIFICATION_TABLE),
    readForeignKeys(seq, REMINDER_TABLE),
    readForeignKeys(seq, NOTIFICATION_TABLE),
    readChecks(seq, REMINDER_TABLE),
  ]);
  const allChecksExist = CHECKS.every((check) => inspectCheck(reminderChecks, check));
  return INDEXES.every((index) => inspectIndex(index.table === REMINDER_TABLE ? reminderIndexes : notificationIndexes, index))
    && FOREIGN_KEYS.every((foreignKey) => inspectForeignKey(
      foreignKey.table === REMINDER_TABLE ? reminderForeignKeys : notificationForeignKeys,
      foreignKey
    ))
    && allChecksExist;
}

module.exports = {
  REMINDER_TABLE,
  NOTIFICATION_TABLE,
  NOTIFICATION_TYPE_VALUES,
  LEGACY_NOTIFICATION_TYPE_VALUES,
  INDEXES,
  FOREIGN_KEYS,
  CHECKS,
  SchemaConflictError,
  parseMysqlEnumValues,
  inspectNotificationTypeColumn,
  readNotificationTypeColumn,
  reminderColumnDefinitions,
  notificationColumnDefinitions,
  assertColumnsCompatible,
  inspectIndex,
  inspectForeignKey,
  normalizeCheck,
  inspectCheck,
  readForeignKeys,
  readChecks,
  inspectReminderSchema,
};
