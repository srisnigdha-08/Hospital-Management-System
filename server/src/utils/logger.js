const winston = require('winston');
const path = require('path');

const env = process.env.NODE_ENV || 'development';

const logger = winston.createLogger({
  level: env === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    env === 'production' ? winston.format.json() : winston.format.colorize({ all: true }),
    env === 'production' ? winston.format.json() : winston.format.simple()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join('logs', 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join('logs', 'combined.log') }),
  ],
  exitOnError: false,
});

module.exports = logger;
