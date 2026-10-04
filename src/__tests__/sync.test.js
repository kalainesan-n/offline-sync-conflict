const request = require('supertest');
const app = require('../server');

// Test database helper functions
const { query, closePool } = require('../utils/prisma');

beforeEach(async () => {
  // Clean up test data before each test
  await query('DELETE FROM note_versions');
  await query('DELETE FROM notes');
  await query('DELETE FROM idempotency_records');
});

afterAll(async () => {
  await closePool();
});

describe('Phase 1: Basic CRUD Operations', () => {
  test('should create a new note', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: {
          title: 'Title v1',
          body: 'Body v1',
          tags: ['initial']
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Verify note was created
    const note = await query('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].title).toBe('Title v1');
    expect(note.rows[0].body).toBe('Body v1');
    expect(note.rows[0].tags).toEqual(['initial']);
    expect(note.rows[0].version).toBe(1);
  });

  test('should return 400 for invalid UUID', async () => {
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId: 'invalid-uuid',
        baseVersion: 0,
        changes: { title: 'Test' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });

  test('should return 400 for negative baseVersion', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: -1,
        changes: { title: 'Test' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });
});