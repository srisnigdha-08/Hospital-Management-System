if (require.main === module) {
  console.error('Direct migration execution is disabled. Run npm run db:migrate from the server directory.');
  process.exitCode = 1;
}

module.exports = {};
