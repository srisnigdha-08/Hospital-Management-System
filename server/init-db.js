const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const dbPassword = process.argv[2] !== undefined ? process.argv[2] : (process.env.DB_PASSWORD || '');
const dbUser = process.env.DB_USER || 'root';
const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = parseInt(process.env.DB_PORT, 10) || 3306;

async function init() {
  console.log(`Connecting to MySQL at ${dbHost}:${dbPort} as "${dbUser}"...`);
  let connection;
  try {
    connection = await mysql.createConnection({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
      multipleStatements: true,
    });
    console.log('✓ Successfully connected to MySQL server!');
  } catch (err) {
    console.error('✗ Failed to connect to MySQL:', err.message);
    process.exit(1);
  }

  try {
    const schemaPath = path.resolve(__dirname, '../database/schema.sql');
    console.log(`Executing schema from: ${schemaPath}...`);
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await connection.query(schemaSql);
    console.log('✓ Database schema created successfully!');

    const seedPath = path.resolve(__dirname, '../database/seed.sql');
    console.log(`Executing seed data from: ${seedPath}...`);
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    await connection.query(seedSql);
    console.log('✓ Database seeded successfully!');

    // Update server/.env if password was passed as argument
    if (process.argv[2] !== undefined) {
      const envPath = path.join(__dirname, '.env');
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/^DB_PASSWORD=.*$/m, `DB_PASSWORD=${dbPassword}`);
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('✓ Updated DB_PASSWORD in server/.env');
    }

    console.log('\nDatabase initialization complete! You can now start the application.');
  } catch (err) {
    console.error('✗ Error executing database scripts:', err.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

init();
