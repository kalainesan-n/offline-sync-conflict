const express = require('express');
const { validationResult, body } = require('express-validator');
const { query, transaction } = require('../utils/prisma');
const crypto = require('crypto');

console.log('DEBUG: historyRoutes module loaded');

const router = express.Router();

// Debug middleware to log all requests to this router
router.use((req, res, next) => {
  console.log(`HISTORY ROUTES DEBUG: ${req.method} ${req.originalUrl}`);
  console.log(`HISTORY ROUTES DEBUG: Mount path: ${req.baseUrl}`);
  console.log(`HISTORY ROUTES DEBUG: Relative path: ${req.path}`);
  next();
});

// Test route to verify routing is working
router.get('/test', (req, res) => {
  console.log('HISTORY ROUTES DEBUG: Test route matched!');
  res.send('Test route works');
});

// Additional test route for parameterized path
router.get('/:testParam/end', (req, res) => {
  console.log(`HISTORY ROUTES DEBUG: Param test route matched! testParam = '${req.params.testParam}'`);
  res.send(`Param test works: ${req.params.testParam}`);
});

// Route to handle empty noteId case (when path contains //versions)
router.get('//versions', async (req, res) => {
  console.log('HISTORY ROUTES DEBUG: Empty noteId route matched!');
  // Treat this as an empty noteId case
  const noteId = '';
  // Manual UUID validation
  console.log(`DEBUG: Original URL: ${req.originalUrl}`);
  console.log(`DEBUG: Base URL: ${req.baseUrl}`);
  console.log(`DEBUG: Path: ${req.path}`);
  console.log(`DEBUG: Received noteId: '${noteId}'`);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidValid = uuidRegex.test(noteId);
  console.log(`DEBUG: UUID validation result: ${uuidValid}`);
  if (!uuidValid) {
    console.log('DEBUG: UUID validation failed, returning 400');
    return res.status(400).json({
      error: 'Validation failed',
      details: [{ msg: 'noteId must be a valid UUID' }]
    });
  }
  console.log('DEBUG: UUID validation passed, continuing');

  // Continue with the rest of the logic (same as the main route handler)
  try {
    // First check if the note exists
    const noteExistsResult = await query(
      'SELECT id FROM notes WHERE id = $1',
      [noteId]
    );

    if (noteExistsResult.rowCount === 0) {
      return res.status(404).json({
        error: 'Note not found',
        details: `No note found with ID: ${noteId}`
      });
    }

    // Get version history, ordered by version (ascending)
    const versionsResult = await query(
      `SELECT version, title, body, tags, changed_at
       FROM note_versions
       WHERE note_id = $1
       ORDER BY version ASC`,
      [noteId]
    );

    const versions = versionsResult.rows.map(version => ({
      version: version.version,
      title: version.title,
      body: version.body,
      tags: version.tags,
      changedAt: version.changed_at
    }));

    res.status(200).json({
      noteId: noteId,
      versions: versions,
      count: versions.length
    });
  } catch (error) {
    console.error('Error retrieving version history:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/notes/:noteId/versions
router.get('/:noteId/versions', async (req, res) => {
  // Manual UUID validation
  console.log(`DEBUG: Original URL: ${req.originalUrl}`);
  console.log(`DEBUG: Base URL: ${req.baseUrl}`);
  console.log(`DEBUG: Path: ${req.path}`);
  const noteId = req.params.noteId;
  console.log(`DEBUG: Received noteId: '${noteId}'`);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidValid = uuidRegex.test(noteId);
  console.log(`DEBUG: UUID validation result: ${uuidValid}`);
  if (!uuidValid) {
    console.log('DEBUG: UUID validation failed, returning 400');
    return res.status(400).json({
      error: 'Validation failed',
      details: [{ msg: 'noteId must be a valid UUID' }]
    });
  }
  console.log('DEBUG: UUID validation passed, continuing');

  try {
    // First check if the note exists
    const noteExistsResult = await query(
      'SELECT id FROM notes WHERE id = $1',
      [noteId]
    );

    if (noteExistsResult.rowCount === 0) {
      return res.status(404).json({
        error: 'Note not found',
        details: `No note found with ID: ${noteId}`
      });
    }

    // Get version history, ordered by version (ascending)
    const versionsResult = await query(
      `SELECT version, title, body, tags, changed_at
       FROM note_versions
       WHERE note_id = $1
       ORDER BY version ASC`,
      [noteId]
    );

    const versions = versionsResult.rows.map(version => ({
      version: version.version,
      title: version.title,
      body: version.body,
      tags: version.tags,
      changedAt: version.changed_at
    }));

    res.status(200).json({
      noteId: noteId,
      versions: versions,
      count: versions.length
    });
  } catch (error) {
    console.error('Error retrieving version history:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Validation middleware for restore endpoint
const restoreValidation = [
  body('versionToRestore').isInt({ min: 1 }).withMessage('versionToRestore must be a positive integer'),
  body('requestId').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).withMessage('requestId must be a valid UUID')
];

// POST /api/notes/:noteId/restore
router.post('/:noteId/restore', [...restoreValidation], async (req, res) => {
  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }

  const { noteId } = req.params;
  const { versionToRestore, requestId } = req.body;

  // Compute payload hash for idempotency
  const payloadHash = crypto.createHash('sha256')
    .update(JSON.stringify(req.body))
    .digest('hex');

  try {
    // Start transaction
    const result = await transaction(async (client) => {
      // Step 1: Idempotency Handling
      // Clean up expired idempotency records
      await client.query(
        `DELETE FROM idempotency_records
         WHERE expires_at < NOW()`);

      // Check for existing record
      const existingRecordResult = await client.query(
        `SELECT * FROM idempotency_records WHERE request_id = $1`,
        [requestId]
      );
      const existingRecord = existingRecordResult.rows[0];

      if (existingRecord) {
        // Check if record is completed
        if (existingRecord.result_status === 200) {
          // Check if payload matches
          if (existingRecord.payload_hash === payloadHash) {
            // Case A: Same requestId + same payload
            return {
              status: 200,
              body: existingRecord.result_body
            };
          } else {
            // Case B: Same requestId + different payload (misuse)
            return {
              status: 422,
              body: {
                error: 'Idempotency key reused with different payload',
                details: {
                  existingPayloadHash: existingRecord.payload_hash,
                  providedPayloadHash: payloadHash
                }
              }
            };
          }
        } else if (existingRecord.result_status === null) {
          // Record is currently being processed
          // Check if payload matches
          if (existingRecord.payload_hash === payloadHash) {
            // Same requestId + same payload, wait for processing to complete
            // In a real implementation, we might wait or retry
            // For simplicity, we'll treat as duplicate and return processing status
            return {
              status: 409,
              body: {
                error: 'Request with this idempotency key is currently being processed',
                details: 'Please retry after a short delay'
              }
            };
          } else {
            // Same requestId + different payload (misuse)
            return {
              status: 422,
              body: {
                error: 'Idempotency key reused with different payload',
                details: {
                  existingPayloadHash: existingRecord.payload_hash,
                  providedPayloadHash: payloadHash
                }
              }
            };
          }
        }
        // If result_status is neither 200 nor null, it's an error state (like 422 or 500)
        // We should treat this as if no valid record exists and proceed
      }

      // No existing record or expired record - insert processing record
      await client.query(
        `INSERT INTO idempotency_records
         (request_id, payload_hash, result_status, result_body, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + COALESCE($5, '24')::int * INTERVAL '1 hour')`,
        [
          requestId,
          payloadHash,
          null, // NULL indicates request is being processed
          null,
          process.env.IDEMPOTENCY_TTL_HOURS
        ]
      );

      // Step 2: Note Row Locking (using SELECT FOR UPDATE)
      let noteResult = await client.query(
        `SELECT * FROM notes WHERE id = $1 FOR UPDATE`,
        [noteId]
      );
      let note = noteResult.rows[0];

      if (!note) {
        // Note doesn't exist
        return {
          status: 404,
          body: {
            error: 'Note not found',
            details: `No note found with ID: ${noteId}`
          }
        };
      }

      // Step 3: Validate that the versionToRestore exists
      const versionExistsResult = await client.query(
        `SELECT version FROM note_versions
         WHERE note_id = $1 AND version = $2`,
        [noteId, versionToRestore]
      );

      if (versionExistsResult.rowCount === 0) {
        return {
          status: 400,
          body: {
            error: 'Version not found',
            details: `No version ${versionToRestore} exists for note ${noteId}`
          }
        };
      }

      // Step 4: Get the state of the note at the target version
      const targetVersionResult = await client.query(
        `SELECT title, body, tags
         FROM note_versions
         WHERE note_id = $1 AND version = $2`,
        [noteId, versionToRestore]
      );

      const targetVersion = targetVersionResult.rows[0];

      // Check if current note already matches target version state
      const isAlreadyAtTargetState =
        note.title === targetVersion.title &&
        note.body === targetVersion.body &&
        JSON.stringify(note.tags || []) === JSON.stringify(targetVersion.tags || []);

      let newVersion;
      let restoredNote;

      if (isAlreadyAtTargetState) {
        newVersion = note.version;
        restoredNote = note;
      } else {
        // Step 5: Determine the new version number
        const currentVersion = note.version;
        newVersion = currentVersion + 1;

        // Step 6: Create the restored version (as a new version)
        await client.query(
          `INSERT INTO note_versions
           (note_id, title, body, tags, version, changed_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            noteId,
            targetVersion.title,
            targetVersion.body,
            targetVersion.tags,
            newVersion
          ]
        );

        // Step 7: Update the current note to match the restored version
        await client.query(
          `UPDATE notes SET
           title = $1, body = $2, tags = $3, version = $4, updated_at = NOW()
           WHERE id = $5`,
          [
            targetVersion.title,
            targetVersion.body,
            targetVersion.tags,
            newVersion,
            noteId
          ]
        );

        // Step 8: Get the updated note
        const updatedNoteResult = await client.query(
          `SELECT * FROM notes WHERE id = $1`,
          [noteId]
        );
        restoredNote = updatedNoteResult.rows[0];
      }

      // Step 9: Build Response
      const responseBody = {
        status: 'accepted',
        note: {
          id: restoredNote.id,
          title: restoredNote.title,
          body: restoredNote.body,
          tags: restoredNote.tags,
          version: restoredNote.version,
          updated_at: restoredNote.updated_at,
          created_at: restoredNote.created_at
        },
        message: `Note restored to version ${versionToRestore} as new version ${newVersion}`,
        restoredVersion: versionToRestore,
        newVersion: newVersion
      };

      // Step 10: Update Idempotency Record with Final Result inside transaction
      await client.query(
        `UPDATE idempotency_records SET
         result_status = $1, result_body = $2
         WHERE request_id = $3`,
        [
          200,
          JSON.stringify(responseBody),
          requestId
        ]
      );

      return {
        status: 200,
        body: responseBody
      };
    });

    res.status(result.status).json(result.body);
  } catch (error) {
    // Log the full error for debugging (never expose internally in production responses)
    console.error('Restore error:', error);

    // Handle specific error types with appropriate status codes
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({
        error: 'Conflict detected',
        details: process.env.NODE_ENV === 'development' ? 'Unique constraint violation' : undefined
      });
    }

    if (error.code === '23503') { // Foreign key violation
      return res.status(400).json({
        error: 'Invalid reference',
        details: process.env.NODE_ENV === 'development' ? 'Foreign key constraint violation' : undefined
      });
    }

    if (error.code === '22001') { // String data right truncation (value too long)
      return res.status(400).json({
        error: 'Value too long',
        details: process.env.NODE_ENV === 'development' ? 'One or more fields exceed the maximum allowed length' : undefined
      });
    }

    if (error.code === '22003') { // Numeric value out of range
      return res.status(400).json({
        error: 'Invalid value',
        details: process.env.NODE_ENV === 'development' ? 'Numeric value out of range' : undefined
      });
    }

    if (error.code === '22P02') { // Invalid text representation
      return res.status(400).json({
        error: 'Invalid input syntax',
        details: process.env.NODE_ENV === 'development' ? 'Invalid input syntax for type' : undefined
      });
    }

    // Generic error response - don't leak internal details in production
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;