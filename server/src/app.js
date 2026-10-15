require('express-async-errors');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const env = require('./config/env');
const logger = require('./utils/logger');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  })
);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  morgan(env.isProduction ? 'combined' : 'dev', {
    stream: { write: (msg) => logger.http(msg.trim()) },
  })
);

// Medical attachments are served exclusively via the authenticated download endpoint:
// GET /api/medical-records/:id/attachments/:attachmentId


app.use('/api', apiLimiter, routes);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'Hospital Management System API', docs: '/api/health' });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
