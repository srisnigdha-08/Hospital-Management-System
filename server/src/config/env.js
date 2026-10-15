const isolatedReminderHarness = process.env.NODE_ENV === 'test'
  && process.env.MERIDIAN_REMINDER_MYSQL_HARNESS === '1'
  && process.env.MERIDIAN_REMINDER_NO_DOTENV === '1';

if (!isolatedReminderHarness) {
  require('dotenv').config();
}
const crypto = require('crypto');
const {
  TEST_DATABASE_NAME,
  normalizeMysqlServerUuid,
  validateTestDatabaseSettings,
} = require('./testDatabaseIdentity');

const INSECURE_DEFAULTS = new Set([
  'dev-access-secret-change-me',
  'dev-refresh-secret-change-me',
  'replace-with-a-long-random-string',
  'replace-with-a-different-long-random-string',
  'change-me',
  'secret',
  'password',
]);

/**
 * Validates JWT access and refresh secrets.
 * - In production: requires non-empty, distinct, 32+ character secrets not matching known defaults.
 * - In development/test: generates process-local secrets if unset.
 * - Never prints secret values.
 */
function validateJwtSecrets(accessSecret, refreshSecret, isProduction = false) {
  if (isProduction) {
    if (!accessSecret || typeof accessSecret !== 'string' || !accessSecret.trim()) {
      throw new Error('Production startup failed: JWT_ACCESS_SECRET is required and cannot be empty');
    }
    if (!refreshSecret || typeof refreshSecret !== 'string' || !refreshSecret.trim()) {
      throw new Error('Production startup failed: JWT_REFRESH_SECRET is required and cannot be empty');
    }
    const trimmedAccess = accessSecret.trim();
    const trimmedRefresh = refreshSecret.trim();

    if (INSECURE_DEFAULTS.has(trimmedAccess.toLowerCase())) {
      throw new Error('Production startup failed: JWT_ACCESS_SECRET cannot use a known insecure default value');
    }
    if (INSECURE_DEFAULTS.has(trimmedRefresh.toLowerCase())) {
      throw new Error('Production startup failed: JWT_REFRESH_SECRET cannot use a known insecure default value');
    }
    if (trimmedAccess.length < 32) {
      throw new Error('Production startup failed: JWT_ACCESS_SECRET must be at least 32 characters long');
    }
    if (trimmedRefresh.length < 32) {
      throw new Error('Production startup failed: JWT_REFRESH_SECRET must be at least 32 characters long');
    }
    if (trimmedAccess === trimmedRefresh) {
      throw new Error('Production startup failed: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct values');
    }
    return { accessSecret: trimmedAccess, refreshSecret: trimmedRefresh };
  }

  const effectiveAccess = (accessSecret && typeof accessSecret === 'string' && accessSecret.trim())
    ? accessSecret.trim()
    : crypto.randomBytes(32).toString('hex');
  const effectiveRefresh = (refreshSecret && typeof refreshSecret === 'string' && refreshSecret.trim())
    ? refreshSecret.trim()
    : crypto.randomBytes(32).toString('hex');

  if (effectiveAccess === effectiveRefresh) {
    throw new Error('Configuration error: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct values');
  }

  return { accessSecret: effectiveAccess, refreshSecret: effectiveRefresh };
}

const nodeEnv = process.env.NODE_ENV || 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) {
  throw new Error('Configuration error: NODE_ENV must be development, test, or production');
}

function validateDatabaseSettings({ nodeEnv: runtime, dbName, dbUser: user, testDbServerUuid }) {
  if (!['development', 'test', 'production'].includes(runtime)) {
    throw new Error('Configuration error: NODE_ENV must be development, test, or production');
  }
  if (runtime === 'test') {
    validateTestDatabaseSettings({ dbName, dbUser: user, expectedServerUuid: testDbServerUuid });
  }
  if (dbName === TEST_DATABASE_NAME && runtime !== 'test') {
    throw new Error(`DB_NAME=${TEST_DATABASE_NAME} requires NODE_ENV=test; refusing database access`);
  }
  if (runtime === 'production' && user?.trim().toLowerCase() === 'root') {
    throw new Error('Production startup failed: DB_USER must not be root');
  }
  return true;
}

const isProduction = nodeEnv === 'production';
const validatedJwt = validateJwtSecrets(process.env.JWT_ACCESS_SECRET, process.env.JWT_REFRESH_SECRET, isProduction);

function required(name, fallback) {
  const value = process.env[name] ?? (isProduction ? undefined : fallback);
  if (value === undefined || (isProduction && !String(value).trim())) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dbUser = required('DB_USER', 'root');
const dbPassword = isProduction ? required('DB_PASSWORD') : process.env.DB_PASSWORD || '';
const dbName = nodeEnv === 'test' ? process.env.DB_NAME : required('DB_NAME', 'hospital_management');
const configuredTestDbServerUuid = process.env.TEST_DB_SERVER_UUID;
validateDatabaseSettings({ nodeEnv, dbName, dbUser, testDbServerUuid: configuredTestDbServerUuid });

const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  testDatabaseName: TEST_DATABASE_NAME,
  testDatabaseServerUuid: nodeEnv === 'test' ? normalizeMysqlServerUuid(configuredTestDbServerUuid) : undefined,
  port: Number(process.env.PORT) || 5000,
  clientUrl: required('CLIENT_URL', 'http://localhost:5173'),

  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(process.env.DB_PORT) || 3306,
    name: dbName,
    user: dbUser,
    password: dbPassword,
    logging: process.env.DB_LOGGING === 'true',
  },

  jwt: {
    accessSecret: validatedJwt.accessSecret,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshSecret: validatedJwt.refreshSecret,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  passwordReset: {
    expiresMinutes: Number(process.env.PASSWORD_RESET_EXPIRES_MIN) || 30,
  },

  rateLimit: {
    windowMinutes: Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15,
    max: Number(process.env.RATE_LIMIT_MAX) || 300,
    authMax: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  },

  upload: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    maxMb: Number(process.env.MAX_UPLOAD_MB) || 10,
  },

  email: {
    from: process.env.EMAIL_FROM || 'no-reply@hms.test',
  },
};

env.validateJwtSecrets = validateJwtSecrets;
env.validateDatabaseSettings = validateDatabaseSettings;

module.exports = env;
