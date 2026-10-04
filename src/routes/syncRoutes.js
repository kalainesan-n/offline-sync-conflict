const express = require('express');
const { body, validationResult } = require('express-validator');
const { syncNote } = require('../controllers/syncController');

const router = express.Router();

// Validation middleware for sync request
const syncValidation = [
  body('noteId').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).withMessage('noteId must be a valid UUID'),
  body('baseVersion').isInt({ min: 0 }).withMessage('baseVersion must be a non-negative integer'),
  body('changes').isObject().withMessage('changes must be an object'),
  body('changes.title').optional().custom((value) => {
    return value === null || value === undefined || typeof value === 'string';
  }).isLength({ max: 255 }),
  body('changes.body').optional().custom((value) => {
    return value === null || value === undefined || typeof value === 'string';
  }),
  body('changes.tags').optional().custom((value) => {
    return value === null || value === undefined || Array.isArray(value);
  }),
  body('requestId').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).withMessage('requestId must be a valid UUID'),
  // Note: Empty changes object is allowed for state checking/synchronization without modifications
// TODO: Consider if we should validate that at least one field is present for actual updates
];

// POST /api/notes/sync
router.post('/sync', syncValidation, syncNote);

module.exports = router;