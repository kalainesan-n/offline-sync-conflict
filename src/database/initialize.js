const { testConnection, query } = require('../utils/prisma');
const fs = require('fs');
const path = require('path');

// Read and execute the SQL initialization script
async function initializeDatabase() {
  try {
    // First test the connection
    await testConnection();

    // Read the SQL file
    const sqlPath = path.join(__dirname, 'init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Execute the SQL
    await query(sql);
    console.log('Database schema initialized successfully');

    // Verify tables were created
    const tablesResult = await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log('Created tables:');
    tablesResult.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1);
  }
}

initializeDatabase();