if (require.main === module) {
  console.error('Direct rollback execution is disabled; use a separately reviewed maintenance procedure.');
  process.exitCode = 1;
}

module.exports = {};
