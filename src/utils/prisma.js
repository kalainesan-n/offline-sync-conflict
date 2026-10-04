// Database connection pool using pg
const { Pool } = require('pg');
require('dotenv').config();

// Create connection pool for our application database
let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Test database connection and create database if needed
async function testConnection() {
  let client;
  try {
    // Try to connect to our target database first
    client = await getPool().connect();
    try {
      await client.query('SELECT 1');
      console.log('Connected to PostgreSQL database');

      // Create tables if they don't exist
      await createTablesIfNotExist(client);

      return;
    } finally {
      client.release();
    }
  } catch (error) {
    // If we can't connect to our target database, it might not exist
    // Try to create it
    if (error.code === '3D000') { // Invalid database name
      console.log('Target database does not exist, attempting to create it...');
      const defaultPool = new Pool({
        connectionString: process.env.DATABASE_URL.replace(/\/[^\/]+$/, '/postgres'),
      });
      try {
        const defaultClient = await defaultPool.connect();
        try {
          // Check if database exists
          const dbNameMatch = process.env.DATABASE_URL.match(/\/([^\/]+)$/);
          const dbName = dbNameMatch ? dbNameMatch[1] : 'offline_sync_conflict';

          const checkResult = await defaultClient.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [dbName]
          );

          if (checkResult.rowCount === 0) {
            // Database doesn't exist, create it
            await defaultClient.query(`CREATE DATABASE "${dbName}"`);
            console.log(`Created database: ${dbName}`);
          } else {
            console.log(`Database ${dbName} already exists`);
          }
        } finally {
          defaultClient.release();
        }
      } finally {
        await defaultPool.end();
      }

      // Now try to connect to our database
      client = await getPool().connect();
      try {
        await client.query('SELECT 1');
        console.log('Connected to PostgreSQL database after creation');

        // Create tables if they don't exist
        await createTablesIfNotExist(client);

        return;
      } finally {
        client.release();
      }
    } else {
      // Some other connection error
      console.error('Database connection error:', error);
      throw error;
    }
  }
}

// Create tables if they don't exist
async function createTablesIfNotExist(client) {
  try {
    // Create notes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        tags TEXT[] NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Create note_versions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS note_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        tags TEXT[] NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL,
        changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

        CONSTRAINT uk_note_id_version UNIQUE (note_id, version)
      )
    `);

    // Create idempotency_records table
    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id VARCHAR(255) NOT NULL UNIQUE,
        payload_hash VARCHAR(64) NOT NULL,
        result_status INTEGER,
        result_body JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL
      )
    `);

    // Create indexes if they don't exist
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notes_version ON notes(version);
      CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id);
      CREATE INDEX IF NOT EXISTS idx_note_versions_version ON note_versions(version);
      CREATE INDEX IF NOT EXISTS idx_idempotency_records_request_id ON idempotency_records(request_id);
      CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at ON idempotency_records(expires_at);
    `);

    console.log('Database schema initialized');
  } catch (error) {
    console.error('Error creating tables:', error);
    throw error;
  }
}

// Execute a query with proper client handling
async function query(text, params) {
  const client = await getPool().connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// Execute a query inside a transaction
async function transaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  get pool() {
    return getPool();
  },
  query,
  transaction,
  testConnection,
  closePool
};