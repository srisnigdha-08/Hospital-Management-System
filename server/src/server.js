const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDb } = require('./config/db');
require('./models'); // registers all Sequelize associations

let server;

async function start() {
  try {
    await connectDb();
    server = app.listen(env.port, () => {
      logger.info(`HMS API listening on http://localhost:${env.port} [${env.nodeEnv}]`);
    });
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason}`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully.');
  server?.close(() => process.exit(0));
});

start();
