const request = require('supertest');
const app = require('../server');
const { query } = require('../utils/prisma');
const crypto = require('crypto');

// Test database helper functions
const { query: dbQuery, closePool } = require('../utils/prisma');

beforeEach(async () => {
  // Clean up test data before each test
  await dbQuery('DELETE FROM note_versions');
  await dbQuery('DELETE FROM notes');
  await dbQuery('DELETE FROM idempotency_records');
});

afterAll(async () => {
  // Clean up after all tests
  await dbQuery('DELETE FROM note_versions');
  await dbQuery('DELETE FROM notes');
  await dbQuery('DELETE FROM idempotency_records');
  await closePool();
});

describe('Phase 8: Final Adversarial Review / Hardening', () => {

  /**
   * Test 1: Race Condition - Two simultaneous sync requests
   * This tests if two requests arriving at nearly the same time
   * can both pass version checks and cause inconsistent state
   */
  test('should handle concurrent sync requests correctly', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const requestId1 = '11111111-1111-1111-1111-111111111111';
    const requestId2 = '22222222-2222-2222-2222-222222222222';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Original Title', body: 'Original Body' },
        requestId: '00000000-0000-0000-0000-000000000000'
      })
      .expect(200);

    // Simulate two concurrent requests by making them quickly
    // Both requests think they're updating from version 1
    const promise1 = request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: { title: 'Updated by Request 1' },
        requestId: requestId1
      });

    const promise2 = request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: { body: 'Updated by Request 2' },
        requestId: requestId2
      });

    // Wait for both requests to complete
    const [response1, response2] = await Promise.all([promise1, promise2]);

    // Both should succeed (200) as they modify different fields
    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);

    // Check final state - should have both changes merged
    const finalNote = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(finalNote.rowCount).toBe(1);
    expect(finalNote.rows[0].title).toBe('Updated by Request 1');
    expect(finalNote.rows[0].body).toBe('Updated by Request 2');
    expect(finalNote.rows[0].version).toBe(3); // Should be version 3 (1 -> 2 -> 3)

    // Verify history has 3 versions
    const history = await dbQuery('SELECT * FROM note_versions WHERE note_id = $1 ORDER BY version', [noteId]);
    expect(history.rowCount).toBe(3);
  });

  /**
   * Test 2: Stale Update Protection - Old request after newer accepted update
   * This tests if an old request can silently overwrite newer data
   */
  test('should prevent stale updates from overwriting newer data', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Original Title' },
        requestId: '00000000-0000-0000-0000-000000000000'
      })
      .expect(200);

    // Update note to version 2
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: { title: 'Updated Title' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Now try to send an OLD request based on version 0 (should be rejected)
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0, // OLD - thinks we're still at version 0
        changes: { title: 'Stale Update Attempt' },
        requestId: '22222222-2222-2222-2222-222222222222'
      })
      .expect(422); // Should be rejected as stale

    // Verify the note is still at version 2 with the proper update
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].title).toBe('Updated Title');
    expect(note.rows[0].version).toBe(2);
  });

  /**
   * Test 3: Idempotency Bypass - Different payload with same requestId
   * This tests if we can bypass idempotency protection by using same ID with different data
   */
  test('should prevent idempotency key misuse with different payloads', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const requestId = '11111111-1111-1111-1111-111111111111';

    // First request
    const response1 = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'First Title' },
        requestId
      })
      .expect(200);

    // Second request with SAME requestId but DIFFERENT payload
    const response2 = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0, // Same baseVersion (would create conflict if processed)
        changes: { title: 'Second Title' }, // DIFFERENT payload
        requestId // SAME requestId
      })
      .expect(422); // Should fail with idempotency conflict

    // Verify only the first change was applied
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].title).toBe('First Title');
    expect(note.rows[0].version).toBe(1);
  });

  /**
   * Test 4: Empty Changes Object - Should not increment version
   * This tests if sending an empty changes object incorrectly increments version
   */
  test('should not increment version for empty changes object', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Original Title' },
        requestId: '00000000-0000-0000-0000-000000000000'
      })
      .expect(200);

    // Send empty changes - should be treated as verification/no-op
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: {}, // Empty changes
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Version should remain unchanged
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].version).toBe(1); // Still version 1
    expect(note.rows[0].title).toBe('Original Title');

    // Response should indicate no changes were made
    expect(response.body.status).toBe('accepted'); // or potentially 'merged' with empty mergedFields
    expect(response.body.mergedFields).toEqual([]);
    expect(response.body.conflictingFields).toEqual([]);
  });

  /**
   * Test 5: Non-existent Note Creation with Specific ID
   * This tests if we can create a note with a specific UUID and if it respects that ID
   */
  test('should create note with client-provided UUID', async () => {
    const customId = '99999999-9999-9999-9999-999999999999';

    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId: customId,
        baseVersion: 0,
        changes: { title: 'Custom ID Title' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Verify note was created with the exact ID provided
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [customId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].id).toBe(customId);
    expect(note.rows[0].title).toBe('Custom ID Title');
    expect(note.rows[0].version).toBe(1);
  });

  /**
   * Test 6: Version Number Overflow Protection
   * This tests what happens with very large version numbers
   */
  test('should handle large version numbers correctly', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create note with high baseVersion
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 999999, // Very high baseVersion
        changes: { title: 'High Version Title' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Should create version 1000000
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].version).toBe(1000000);
    expect(note.rows[0].title).toBe('High Version Title');
  });

  /**
   * Test 7: Malformed JSON Payloads
   * This tests if malformed JSON can bypass validation
   */
  test('should reject malformed JSON payloads', async () => {
    // This test would require sending raw malformed HTTP,
    // which is difficult with supertest. Instead we test validation of known bad fields
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Test invalid data types
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 'not-a-number', // Should be number
        changes: { title: 'Test' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });

  /**
   * Test 8: Extremely Large Payloads
   * This tests if oversized payloads cause issues
   */
  test('should handle extremely large payloads appropriately', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const largeString = 'x'.repeat(10000); // 10KB string

    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: largeString, body: largeString },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(400); // Should fail validation due to size limits

    expect(response.body.error).toBe('Validation failed');
  });

  /**
   * Test 9: SQL Injection Attempts
   * This tests if SQL injection is possible through any fields
   */
  test('should prevent SQL injection attempts', async () => {
    // Try common SQL injection payloads
    const sqlInjectionAttempts = [
      "title'; DROP TABLE notes; --",
      "title' OR '1'='1",
      "title'; DELETE FROM notes WHERE '1'='1",
      "title UNION SELECT * FROM notes"
    ];

    for (const attempt of sqlInjectionAttempts) {
      const noteId = crypto.randomUUID();
      const response = await request(app)
        .post('/api/notes/sync')
        .send({
          noteId,
          baseVersion: 0,
          changes: { title: attempt },
          requestId: crypto.randomUUID()
        })
        .expect(200); // Should succeed as normal update (data stored literally)

      // Verify the literal string was stored, not executed as SQL
      const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
      expect(note.rowCount).toBe(1);
      expect(note.rows[0].title).toBe(attempt);
    }
  });

  /**
   * Test 10: Concurrent Restore Operations
   * This tests if concurrent restore operations cause issues
   */
  test('should handle concurrent restore operations correctly', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const requestId1 = '11111111-1111-1111-1111-111111111111';
    const requestId2 = '22222222-2222-2222-2222-222222222222';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Original Title', body: 'Original Body' },
        requestId: '00000000-0000-0000-0000-000000000000'
      })
      .expect(200);

    // Update to version 2
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: { title: 'Updated Title' },
        requestId: '33333333-3333-3333-3333-333333333333'
      })
      .expect(200);

    // Try to restore version 1 concurrently from two different requests
    const restorePromise1 = request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send({
        versionToRestore: 1,
        requestId: requestId1
      });

    const restorePromise2 = request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send({
        versionToRestore: 1,
        requestId: requestId2
      });

    const [response1, response2] = await Promise.all([restorePromise1, restorePromise2]);

    // Both should succeed (first one wins, second should be idempotent)
    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);

    // Both should return same result (idempotency)
    expect(response1.body).toEqual(response2.body);

    // Should have created version 3 (restored version 1 as new version)
    expect(response1.body.note.version).toBe(3);
    expect(response1.body.restoredVersion).toBe(1);
    expect(response1.body.newVersion).toBe(3);

    // Verify final state matches version 1
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].title).toBe('Original Title');
    expect(note.rows[0].body).toBe('Original Body');
    expect(note.rows[0].version).toBe(3);
  });

  /**
   * Test 11: Restore Non-existent Version Edge Cases
   * This tests edge cases around version restoration
   */
  test('should handle edge cases in version restoration', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create a note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Test Title' },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    // Try to restore version 0 (invalid - too low)
    let response = await request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send({
        versionToRestore: 0,
        requestId: '22222222-2222-2222-2222-222222222222'
      })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');

    // Try to restore negative version
    response = await request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send({
        versionToRestore: -1,
        requestId: '33333333-3333-3333-3333-333333333333'
      })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');

    // Try to restore non-existent high version
    response = await request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send({
        versionToRestore: 999,
        requestId: '44444444-4444-4444-4444-444444444444'
      })
      .expect(400);

    expect(response.body.error).toBe('Version not found');
  });

  /**
   * Test 12: Request ID Format Validation
   * This tests if malformed request IDs are properly rejected
   */
  test('should validate requestId format correctly', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    const invalidRequestIds = [
      'invalid-request-id',
      '11111111-1111-1111-1111-11111111111', // too short
      '11111111-1111-1111-1111-1111111111111', // too long
      'gggggggg-gggg-gggg-gggg-gggggggggggg', // invalid hex
      '' // empty string
    ];

    for (const invalidId of invalidRequestIds) {
      const response = await request(app)
        .post('/api/notes/sync')
        .send({
          noteId,
          baseVersion: 0,
          changes: { title: 'Test' },
          requestId: invalidId
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
    }
  });

  /**
   * Test 13: Duplicate Detection After Server Restart
   * This tests if idempotency records persist correctly
   * Note: In real test environment, we can't easily restart server,
   * but we can test the database persistence aspect
   */
  test('should maintain idempotency records in database', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const requestId = '11111111-1111-1111-1111-111111111111';

    // Make a request
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Test Title' },
        requestId
      })
      .expect(200);

    // Check that idempotency record was created in database
    const idempotencyRecord = await dbQuery(
      'SELECT * FROM idempotency_records WHERE request_id = $1',
      [requestId]
    );

    expect(idempotencyRecord.rowCount).toBe(1);
    expect(idempotencyRecord.rows[0].request_id).toBe(requestId);
    expect(idempotencyRecord.rows[0].result_status).toBe(200);
    expect(idempotencyRecord.rows[0].result_body).not.toBeNull();

    // Make same request again - should return cached result
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Test Title' },
        requestId
      })
      .expect(200);

    // Should be identical to first response (cached)
    expect(response.body.status).toBe('accepted');
    expect(response.body.note.title).toBe('Test Title');
  });

  /**
   * Test 14: Expired Idempotency Records Cleanup
   * This tests if expired records are properly cleaned up
   */
  test('should clean up expired idempotency records', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';
    const requestId = '11111111-1111-1111-1111-111111111111';

    // Manually insert an expired idempotency record
    const expiredTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    await dbQuery(
      `INSERT INTO idempotency_records
       (request_id, payload_hash, result_status, result_body, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        requestId,
        'dummy-hash',
        200,
        '{"status":"accepted"}',
        expiredTime
      ]
    );

    // Verify expired record exists
    let record = await dbQuery(
      'SELECT * FROM idempotency_records WHERE request_id = $1',
      [requestId]
    );
    expect(record.rowCount).toBe(1);

    // Make a new request - this should trigger cleanup of expired record
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'New Title' },
        requestId: '22222222-2222-2222-2222-222222222222' // Different ID
      })
      .expect(200);

    // Verify expired record was cleaned up
    record = await dbQuery(
      'SELECT * FROM idempotency_records WHERE request_id = $1',
      [requestId]
    );
    expect(record.rowCount).toBe(0); // Should be cleaned up
  });

  /**
   * Test 15: Field Names Outside Expected Set
   * This tests if unexpected field names in changes object are handled properly
   */
  test('should ignore unexpected field names in changes object', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: {
          title: 'Valid Title',
          invalidField: 'Should Be Ignored',
          anotherInvalidField: 12345
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Should only process valid fields (title)
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].title).toBe('Valid Title');
    expect(note.rows[0].body).toBe(''); // Default empty body
    expect(note.rows[0].tags).toEqual([]); // Default empty array

    // Response should show only title was processed
    expect(response.body.mergedFields).toEqual(['title']);
    expect(response.body.conflictingFields).toEqual([]);
  });

  /**
   * Test 16: Array Field Handling (tags)
   * This tests proper handling of array fields like tags
   */
  test('should correctly handle array field comparisons and conflicts', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create initial note with tags
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Test', tags: ['tag1', 'tag2'] },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Simultaneous updates to tags array from two different "devices"
    const [response1, response2] = await Promise.all([
      request(app)
        .post('/api/notes/sync')
        .send({
          noteId,
          baseVersion: 1,
          changes: { tags: ['tag1', 'tag3'] }, // Changed tag2 to tag3
          requestId: '22222222-2222-2222-2222-222222222222'
        }),
      request(app)
        .post('/api/notes/sync')
        .send({
          noteId,
          baseVersion: 1,
          changes: { tags: ['tag1', 'tag4'] }, // Changed tag2 to tag4
          requestId: '33333333-3333-3333-3333-333333333333'
        })
    ]);

    // One should succeed, one should detect conflict
    const statuses = [response1.status, response2.status].sort();
    expect(statuses).toEqual([200, 200]); // Both succeed as they modify same field but we need to check if conflict detected

    // Check final state and conflicts
    const finalNote = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(finalNote.rowCount).toBe(1);

    // One of the responses should show conflict on tags field
    const hasConflict =
      (response1.body.status === 'conflict' && response1.body.conflictingFields.includes('tags')) ||
      (response2.body.status === 'conflict' && response2.body.conflictingFields.includes('tags'));

    expect(hasConflict).toBe(true); // At least one should detect conflict
  });

  /**
   * Test 17: Base Version Higher Than Current Version
   * This tests if client can "time travel" by claiming to have seen a future version
   */
  test('should reject baseVersion claims higher than current version', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Original Title' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Try to sync with baseVersion claiming to be from the future
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 5, // Claiming to have seen version 5 when we're only at version 1
        changes: { title: 'Future Knowledge Title' },
        requestId: '22222222-2222-2222-2222-222222222222'
      })
      .expect(422); // Should be rejected

    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details.baseVersion).toBe('Client baseVersion is newer than current server version');
  });

  /**
   * Test 18: Zero Base Version for Existing Note
   * This tests syncing with baseVersion 0 on an existing note
   */
  test('should handle baseVersion 0 on existing note correctly', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create a note at version 3
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Title V1' },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: { title: 'Title V2' },
        requestId: '22222222-2222-2222-2222-222222222222'
      });

    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 2,
        changes: { title: 'Title V3' },
        requestId: '33333333-3333-3333-3333-333333333333'
      });

    // Now try to sync with baseVersion 0 (thinking it's still at the beginning)
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0, // Think we're at version 0
        changes: { title: 'Stale Title From Beginning' },
        requestId: '44444444-4444-4444-4444-444444444444'
      })
      .expect(422); // Should be rejected as stale

    // Note should remain at version 3
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].title).toBe('Title V3');
    expect(note.rows[0].version).toBe(3);
  });

  /**
   * Test 19: Special Characters in Fields
   * This tests handling of special characters, Unicode, etc.
   */
  test('should handle special characters and Unicode correctly', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    const specialTitle = 'Title with émojis 🚀 and spëcial chåråcters: \'\"\\&<>';
    const specialBody = 'Body with line\nbreaks\tand\tabsurd☃unicode';

    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: specialTitle, body: specialBody },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Verify special characters were preserved exactly
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    expect(note.rows[0].title).toBe(specialTitle);
    expect(note.rows[0].body).toBe(specialBody);
  });

  /**
   * Test 20: Null and Undefined Values in Changes
   * This tests how null/undefined values in changes object are handled
   */
  test('should handle null and undefined values in changes object', async () => {
    const noteId = '550e8400-e29b-41d4-a716-446655440000';

    // Create initial note
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Original Title', body: 'Original Body' },
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(200);

    // Try to update with null/undefined values
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: {
          title: null,
          undefinedField: undefined,
          body: 'Updated Body'
        },
        requestId: '22222222-2222-2222-2222-222222222222'
      })
      .expect(200);

    // Null title should be stored as null string "undefined" or similar based on validation
    // Actually, let's check what happens - the validation might reject null values
    const note = await dbQuery('SELECT * FROM notes WHERE id = $1', [noteId]);
    expect(note.rowCount).toBe(1);
    // The behavior depends on how express-validator handles null values
  });
});
