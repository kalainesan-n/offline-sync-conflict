const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const swaggerUi = require('swagger-ui-express');

const { testConnection } = require('./utils/prisma');
const syncRoutes = require('./routes/syncRoutes');
const historyRoutes = require('./routes/historyRoutes');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Swagger/OpenAPI documentation
const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Offline Sync Conflict API',
    version: '1.0.0',
    description: 'API for synchronizing notes across multiple devices with conflict detection and resolution'
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Development server'
    }
  ],
  paths: {
    '/': {
      get: {
        summary: 'API health check',
        responses: {
          '200': {
            description: 'API is running',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Offline Sync Conflict API'
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/notes/sync': {
      post: {
        summary: 'Synchronize note changes',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['noteId', 'baseVersion', 'changes', 'requestId'],
                properties: {
                  noteId: {
                    type: 'string',
                    format: 'uuid',
                    description: 'Unique identifier for the note'
                  },
                  baseVersion: {
                    type: 'integer',
                    minimum: 0,
                    description: 'The version of the note that the client last knew about'
                  },
                  changes: {
                    type: 'object',
                    description: 'The changes to apply to the note',
                    properties: {
                      title: { type: 'string' },
                      body: { type: 'string' },
                      tags: {
                        type: 'array',
                        items: { type: 'string' }
                      }
                    }
                  },
                  requestId: {
                    type: 'string',
                    format: 'uuid',
                    description: 'Unique identifier for this request (used for idempotency)'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Synchronization result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: {
                      type: 'string',
                      enum: ['accepted', 'merged', 'conflict']
                    },
                    note: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        title: { type: 'string' },
                        body: { type: 'string' },
                        tags: {
                          type: 'array',
                          items: { type: 'string' }
                        },
                        version: { type: 'integer' },
                        updated_at: { type: 'string', format: 'date-time' },
                        created_at: { type: 'string', format: 'date-time' }
                      }
                    },
                    baseVersion: { type: 'integer' },
                    currentVersion: { type: 'integer' },
                    mergedFields: {
                      type: 'array',
                      items: { type: 'string' }
                    },
                    conflictingFields: {
                      type: 'array',
                      items: { type: 'string' }
                    },
                    conflicts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          field: { type: 'string' },
                          clientValue: { type: 'string' },
                          serverValue: { type: 'string' },
                          baseValue: { type: 'string' }
                        }
                      }
                    },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': {
            description: 'Validation error',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: { type: 'array' }
                  }
                }
              }
            }
          },
          '404': {
            description: 'Note not found',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: { type: 'string' }
                  }
                }
              }
            }
          },
          '422': {
            description: 'Idempotency key reused with different payload',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: {
                      type: 'object',
                      properties: {
                        existingPayloadHash: { type: 'string' },
                        providedPayloadHash: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          },
          '409': {
            description: 'Request currently being processed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/notes/:noteId/versions': {
      get: {
        summary: 'Get version history for a note',
        parameters: [
          {
            in: 'path',
            name: 'noteId',
            required: true,
            schema: {
              type: 'string',
              format: 'uuid'
            }
          }
        ],
        responses: {
          '200': {
            description: 'Version history retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    noteId: { type: 'string', format: 'uuid' },
                    versions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          version: { type: 'integer' },
                          title: { type: 'string' },
                          body: { type: 'string' },
                          tags: {
                            type: 'array',
                            items: { type: 'string' }
                          },
                          changedAt: { type: 'string', format: 'date-time' }
                        }
                      }
                    },
                    count: { type: 'integer' }
                  }
                }
              }
            }
          },
          '400': {
            description: 'Validation error',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: { type: 'array' }
                  }
                }
              }
            }
          },
          '404': {
            description: 'Note not found',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/notes/:noteId/restore': {
      post: {
        summary: 'Restore a previous version of a note',
        parameters: [
          {
            in: 'path',
            name: 'noteId',
            required: true,
            schema: {
              type: 'string',
              format: 'uuid'
            }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['versionToRestore', 'requestId'],
                properties: {
                  versionToRestore: {
                    type: 'integer',
                    minimum: 1,
                    description: 'The version number to restore'
                  },
                  requestId: {
                    type: 'string',
                    format: 'uuid',
                    description: 'Unique identifier for this request (used for idempotency)'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Note restored successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['accepted'] },
                    note: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        title: { type: 'string' },
                        body: { type: 'string' },
                        tags: {
                          type: 'array',
                          items: { type: 'string' }
                        },
                        version: { type: 'integer' },
                        updated_at: { type: 'string', format: 'date-time' },
                        created_at: { type: 'string', format: 'date-time' }
                      }
                    },
                    message: { type: 'string' },
                    restoredVersion: { type: 'integer' },
                    newVersion: { type: 'integer' }
                  }
                }
              }
            }
          },
          '400': {
            description: 'Validation error or version not found',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: { type: 'string' }
                  }
                }
              }
            }
          },
          '404': {
            description: 'Note not found',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    details: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Offline Sync Conflict API' });
});

app.use('/api/notes', syncRoutes);
app.use('/api/notes', historyRoutes);

// Swagger UI route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

const startServer = async () => {
  try {
    await testConnection();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

module.exports = app;