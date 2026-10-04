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

describe('Phase 5: Version History API', () => {
  test('should retrieve version history for a note with multiple versions', async () => {
    const noteId = '660e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId: noteId,
        baseVersion: 0,
        changes: {
          title: 'Title v1',
          body: 'Body v1',
          tags: ['initial']
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    // Update note (version 2)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId: noteId,
        baseVersion: 1,
        changes: {
          title: 'Title v2',
          tags: ['updated']
        },
        requestId: '22222222-2222-2222-2222-222222222222'
      });

    // Update note again (version 3)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId: noteId,
        baseVersion: 2,
        changes: {
          body: 'Body v3'
        },
        requestId: '33333333-3333-3333-3333-333333333333'
      });

    // Get version history
    const response = await request(app)
      .get(`/api/notes/${noteId}/versions`)
      .expect(200);

    expect(response.body.noteId).toBe(noteId);
    expect(response.body.versions).toHaveLength(3);
    expect(response.body.count).toBe(3);

    // Check version 1
    expect(response.body.versions[0].version).toBe(1);
    expect(response.body.versions[0].title).toBe('Title v1');
    expect(response.body.versions[0].body).toBe('Body v1');
    expect(response.body.versions[0].tags).toEqual(['initial']);
    expect(response.body.versions[0].changedAt).toBeDefined();

    // Check version 2
    expect(response.body.versions[1].version).toBe(2);
    expect(response.body.versions[1].title).toBe('Title v2');
    expect(response.body.versions[1].body).toBe('Body v1'); // unchanged
    expect(response.body.versions[1].tags).toEqual(['updated']);
    expect(response.body.versions[1].changedAt).toBeDefined();

    // Check version 3
    expect(response.body.versions[2].version).toBe(3);
    expect(response.body.versions[2].title).toBe('Title v2'); // unchanged
    expect(response.body.versions[2].body).toBe('Body v3');
    expect(response.body.versions[2].tags).toEqual(['updated']); // unchanged
    expect(response.body.versions[2].changedAt).toBeDefined();
  });

  test('should return empty history for note with no versions', async () => {
    const noteId = '777e8400-e29b-41d4-a716-446655440000';

    // Create a note but don't update it (should have 1 version from creation)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: {
          title: 'Test Title: Solo Title',
          body: 'Solo Body'
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    const response = await request(app)
      .get(`/api/notes/${noteId}/versions`)
      .expect(200);

    expect(response.body.noteId).toBe(noteId);
    expect(response.body.versions).toHaveLength(1);
    expect(response.body.count).toBe(1);
    expect(response.body.versions[0].version).toBe(1);
    expect(response.body.versions[0].title).toBe('Test Title: Solo Title');
    expect(response.body.versions[0].body).toBe('Solo Body');
  });

  test('should return 404 for nonexistent note', async () => {
    const response = await request(app)
      .get('/api/notes/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/versions')
      .expect(404);

    expect(response.body.error).toBe('Note not found');
  });

  test('should validate noteId format', async () => {
    const invalidUuids = [
      'invalid-uuid',
      '123',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa', // too short
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaaaa', // too long
      'gggggggg-gggg-gggg-gggg-gggggggggggg', // invalid hex
      ''
    ];

    for (const invalidUuid of invalidUuids) {
      const response = await request(app)
        .get(`/api/notes/${invalidUuid}/versions`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    }
  });
});

describe('Phase 5: Restore Previous Version', () => {
  test('should restore a previous version as a new version', async () => {
    const noteId = '888e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: {
          title: 'Original Title',
          body: 'Original Body',
          tags: ['original']
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    // Update to version 2
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: {
          title: 'Updated Title',
          body: 'Updated Body'
        },
        requestId: '22222222-2222-2222-2222-222222222222'
      });

    // Update to version 3
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 2,
        changes: {
          tags: ['tag1', 'tag2']
        },
        requestId: '33333333-3333-3333-3333-333333333333'
      });

    // Restore version 1 (should create version 4)
    const response = await request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send({
        versionToRestore: 1,
        requestId: '44444444-4444-4444-4444-444444444444'
      })
      .expect(200);

    expect(response.body.status).toBe('accepted');
    expect(response.body.note).toMatchObject({
      id: noteId,
      title: 'Original Title',
      body: 'Original Body',
      tags: ['original'],
      version: 4
    });
    expect(response.body.message).toBe('Note restored to version 1 as new version 4');
    expect(response.body.restoredVersion).toBe(1);
    expect(response.body.newVersion).toBe(4);

    // Verify that the version history still contains all versions
    const historyResponse = await request(app)
      .get(`/api/notes/${noteId}/versions`)
      .expect(200);

    expect(historyResponse.body.versions).toHaveLength(4);
    expect(historyResponse.body.count).toBe(4);

    // Check that versions 1-3 are unchanged
    expect(historyResponse.body.versions[0]).toMatchObject({
      version: 1,
      title: 'Original Title',
      body: 'Original Body',
      tags: ['original']
    });
    expect(historyResponse.body.versions[1]).toMatchObject({
      version: 2,
      title: 'Updated Title',
      body: 'Updated Body',
      tags: ['original'] // unchanged from version 1
    });
    expect(historyResponse.body.versions[2]).toMatchObject({
      version: 3,
      title: 'Updated Title', // unchanged from version 2
      body: 'Updated Body',
      tags: ['tag1', 'tag2']
    });

    // Check that version 4 matches the restored state
    expect(historyResponse.body.versions[3]).toMatchObject({
      version: 4,
      title: 'Original Title',
      body: 'Original Body',
      tags: ['original']
    });
  });

  test('should return 404 when trying to restore from nonexistent note', async () => {
    const response = await request(app)
      .post('/api/notes/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/restore')
      .send({
        versionToRestore: 1,
        requestId: '11111111-1111-1111-1111-111111111111'
      })
      .expect(404);

    expect(response.body.error).toBe('Note not found');
  });

  test('should return 400 when trying to restore to nonexistent version', async () => {
    const noteId = '660e8400-e29b-41d4-a716-446655440000';

    // Create a note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Test Title' },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    // Try to restore version 5 (doesn't exist)
    const response = await request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send({
        versionToRestore: 5,
        requestId: '22222222-2222-2222-2222-222222222222'
      })
      .expect(400);

    expect(response.body.error).toBe('Version not found');
  });

  test('should validate versionToRestore format', async () => {
    const noteId = '660e8400-e29b-41d4-a716-446655440000';

    // Create a note first
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: { title: 'Test Title' },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    const invalidVersions = [
      0, // too low (minimum is 1)
      -1, // negative
      'invalid', // not a number
      3.14 // not an integer
    ];

    for (const invalidVersion of invalidVersions) {
      const response = await request(app)
        .post(`/api/notes/${noteId}/restore`)
        .send({
          versionToRestore: invalidVersion,
          requestId: '11111111-1111-1111-1111-111111111111'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    }
  });

  test('should handle idempotency for restore requests', async () => {
    const noteId = '660e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: {
          title: 'Original Title',
          body: 'Original Body'
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    // Update to version 2
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: {
          title: 'Updated Title'
        },
        requestId: '22222222-2222-2222-2222-222222222222'
      });

    const requestId = '33333333-3333-3333-3333-333333333333';
    const restoreRequest = {
      versionToRestore: 1,
      requestId: requestId
    };

    // First restore request
    const response1 = await request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send(restoreRequest)
      .expect(200);

    // Second restore request with same ID
    const response2 = await request(app)
      .post(`/api/notes/${noteId}/restore`)
      .send(restoreRequest)
      .expect(200);

    // Should return identical results
    expect(response1.body).toEqual(response2.body);

    // Both should have created a new version (version 3)
    expect(response1.body.note.version).toBe(3);
    expect(response2.body.note.version).toBe(3);
  });
});

describe('Phase 5: Enhanced Conflict Response', () => {
  test('should provide enhanced conflict response with baseVersion and currentVersion', async () => {
    const noteId = '660e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: {
          title: 'Original Title',
          body: 'Original Body',
          tags: ['original']
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    // Update to version 2 (simulate another device)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: {
          title: 'Updated by Other Device',
          body: 'Updated Body'
        },
        requestId: '22222222-2222-2222-2222-222222222222'
      });

    // First device tries to update based on outdated version (should detect conflict)
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1, // Still thinks it's at version 1
        changes: {
          title: 'Updated by First Device',
          body: 'Original Body' // trying to revert body to original
        },
        requestId: '33333333-3333-3333-3333-333333333333'
      })
      .expect(200);

    expect(response.body.status).toBe('conflict');
    expect(response.body.baseVersion).toBe(1);
    expect(response.body.currentVersion).toBe(3);
    expect(response.body.mergedFields).toEqual(['body']); // body was merged (non-conflicting)
    expect(response.body.conflictingFields).toEqual(['title']); // title conflicted
    expect(response.body.conflicts).toHaveLength(1);
    expect(response.body.conflicts[0]).toMatchObject({
      field: 'title',
      clientValue: 'Updated by First Device',
      serverValue: 'Updated by Other Device',
      baseValue: 'Original Title'
    });
    expect(response.body.message).toBe('Conflict detected - some changes were merged, others conflicted');
  });

  test('should show no merged fields when all changes conflict', async () => {
    const noteId = '660e8400-e29b-41d4-a716-446655440000';

    // Create initial note (version 1)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 0,
        changes: {
          title: 'Original Title',
          body: 'Original Body'
        },
        requestId: '11111111-1111-1111-1111-111111111111'
      });

    // Update to version 2 (simulate another device changing both fields)
    await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1,
        changes: {
          title: 'Updated Title',
          body: 'Updated Body'
        },
        requestId: '22222222-2222-2222-2222-222222222222'
      });

    // First device tries to update based on outdated version (should detect conflict on all fields)
    const response = await request(app)
      .post('/api/notes/sync')
      .send({
        noteId,
        baseVersion: 1, // Still thinks it's at version 1
        changes: {
          title: 'Different Title',
          body: 'Different Body'
        },
        requestId: '33333333-3333-3333-3333-333333333333'
      })
      .expect(200);

    expect(response.body.status).toBe('conflict');
    expect(response.body.baseVersion).toBe(1);
    expect(response.body.currentVersion).toBe(3);
    expect(response.body.mergedFields).toEqual([]); // no fields merged
    expect(response.body.conflictingFields).toEqual(['title', 'body']); // both fields conflicted
    expect(response.body.conflicts).toHaveLength(2);
    expect(response.body.message).toBe('Conflict detected - no changes were made due to all changes conflicting');
  });
});