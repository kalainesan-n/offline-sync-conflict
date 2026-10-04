# Offline Sync Conflict Backend

## Problem Statement

When users work with the same data across multiple devices offline, conflicts can occur when those devices come back online and attempt to synchronize their changes. Without proper conflict detection and resolution mechanisms, one device's changes can silently overwrite another's, leading to data loss and user frustration.

This backend implements a robust synchronization system that detects conflicts instead of silently overwriting data, preserves valid changes wherever possible, and provides clear feedback about synchronization outcomes.

## Features

- **Conflict Detection**: Identifies when multiple devices have modified the same fields
- **Change Preservation**: Preserves non-conflicting changes even when conflicts occur
- **Version Tracking**: Maintains history of all accepted states for accurate change detection
- **Optimistic Concurrency**: Uses version-based checking to detect stale updates
- **Idempotency**: Safely handles duplicate synchronization requests
- **Transaction Safety**: All operations occur in atomic transactions to prevent race conditions
- **Clear API Responses**: Distinguishes between accepted, merged, and conflict outcomes
- **Version History**: Ability to view and restore previous versions of notes
- **Field-Level Granularity**: Detects and handles conflicts at the field level

## Architecture

```
Client/Device
      ↓
Express API (Node.js)
      ↓
Sync / Conflict Logic
      ↓
PostgreSQL Database
      ├── notes (current state)
      ├── note_versions (historical snapshots)
      └── idempotency_records (for duplicate request handling)
```

### Data Flow

1. Client sends synchronization request with:
   - `noteId`: UUID of the note
   - `baseVersion`: Last known version from client's perspective
   - `changes`: Fields the client wants to update
   - `requestId`: UUID for idempotency

2. Server:
   - Validates the request
   - Checks idempotency (persistent database-backed)
   - Locks the note row to prevent concurrent updates
   - Retrieves current state and state at `baseVersion`
   - Determines what changed on server since `baseVersion`
   - Compares client changes with server changes:
     - No overlap → Changes can be safely merged
     - Same field changed → Conflict detected
   - Applies non-conflicting changes, preserves server's conflicting changes
   - Creates new version if state changed
   - Records change in history
   - Updates idempotency record with result
   - Returns synchronization result

## Technology Stack

- **Backend**: Node.js + Express.js
- **Database**: PostgreSQL
- **Database Driver**: pg (native PostgreSQL client)
- **API Documentation**: Swagger/OpenAPI (via swagger-ui-express)
- **Testing**: Jest + Supertest
- **Environment Configuration**: dotenv

## Data Model

### Notes Table (Current State)
```sql
CREATE TABLE notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Note Versions Table (Historical Snapshots)
```sql
CREATE TABLE note_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    version INTEGER NOT NULL,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT uk_note_id_version UNIQUE (note_id, version)
);
```

### Idempotency Records Table
```sql
CREATE TABLE idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(255) NOT NULL UNIQUE,
    payload_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of the payload
    result_status INTEGER, -- HTTP status code (NULL indicates request is being processed)
    result_body JSONB, -- The response body stored as JSON
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
```

## Synchronization Model

The system implements optimistic concurrency with version tracking:

1. **Client Perspective**: Client believes it last saw the note at `baseVersion`
2. **Server Perspective**: Server knows the current version and maintains historical snapshots
3. **Change Detection**: By comparing snapshots at `baseVersion` and current version, server determines exactly what changed since the client's last known state
4. **Conflict Resolution**:
   - If client and server changed different fields → Changes are merged
   - If client and server changed the same field → Conflict detected (client must resolve)
   - Non-conflicting changes are always preserved when possible

## Version Tracking

Every accepted state transition creates a new entry in the `note_versions` table:
- Each version represents a immutable snapshot of the note at that point in time
- Enables precise change detection between any two versions
- Supports viewing history and restoring previous versions
- Provides audit trail of all accepted changes

## Conflict Detection

Field-level conflict detection compares:
- What the client wants to change (from request)
- What actually changed on the server since the client's `baseVersion` (from version history)

A conflict occurs when both the client and server have modified the same field since the client's last known state.

## Conflict Resolution Policy

When conflicts are detected:
1. **Non-conflicting changes**: Automatically merged and applied
2. **Conflicting changes**: Preserved in the server's version (not overwritten)
3. **Response**: Returns status `conflict` with detailed information about each conflicting field
4. **Client Responsibility**: Must resolve conflicts and retry with appropriate changes

This policy follows the requirements to:
- Preserve valid changes wherever possible
- Distinguish changes that can safely coexist from those requiring resolution
- Prevent silent overwriting of newer accepted changes
- Provide deterministic and explainable behavior

## Idempotency

To handle duplicate requests:
- Each synchronization request includes a unique `requestId` (UUID)
- Server maintains a record of recent request IDs with payload hashes
- Duplicate requests with the same ID and payload return the original result
- Duplicate requests with the same ID but different payload return a 422 error (idempotency-key misuse)
- Records expire after a configurable time period (default 24 hours) to prevent unbounded growth

## Concurrency Handling

The system handles concurrent requests safely through:
- **Row-Level Locking**: Uses `SELECT FOR UPDATE` to lock notes during processing
- **Atomic Transactions**: All operations (validation, idempotency check, locking, change detection, update, history recording) occur in a single database transaction
- **Proper Isolation**: Prevents race conditions like:
  - Two requests both passing version check
  - Old requests overwriting newer accepted changes
  - Inconsistent state between current note and version history

## API Documentation

### Base URL
```
/api
```

### Endpoints

#### POST /notes/sync
Synchronize note changes from client device

**Request:**
```json
{
  "noteId": "string (uuid)",
  "baseVersion": "integer (>= 0)",
  "changes": {
    "title?: string",
    "body?: string",
    "tags?: string[]"
  },
  "requestId": "string (uuid)"
}
```

**Responses:**

**200 OK** - Successfully processed
```json
{
  "status": "accepted|merged|conflict",
  "note": {
    "id": "string (uuid)",
    "title": "string",
    "body": "string",
    "tags": "string[]",
    "version": "integer",
    "updatedAt": "ISO 8601 timestamp",
    "createdAt": "ISO 8601 timestamp"
  },
  "message": "string",
  "conflicts": [
    // Only present when status is "conflict"
    {
      "field": "string (one of: title|body|tags)",
      "clientValue": "*",
      "serverValue": "*",
      "baseValue": "*"
    }
  ]
}
```

**400 Bad Request** - Invalid request format
```json
{
  "error": "string (description of validation error)",
  "details": {
    "field": "string",
    "issue": "string"
  }
}
```

**422 Unprocessable Entity** - Validation failed or idempotency-key misuse
```json
{
  "error": "string",
  "details": {
    "baseVersion": "Client baseVersion is newer than current server version",
    "idempotency": "Idempotency key reused with different payload"
  }
}
```

#### GET /notes/:id
Retrieve current state of a note

**Response (200 OK):**
```json
{
  "id": "string (uuid)",
  "title": "string",
  "body": "string",
  "tags": "string[]",
  "version": "integer",
  "updatedAt": "ISO 8601 timestamp",
  "createdAt": "ISO 8601 timestamp"
}
```

#### GET /notes/:id/versions
Retrieve version history for a note

**Response (200 OK):**
```json
{
  "noteId": "string (uuid)",
  "versions": [
    {
      "version": "integer",
      "title": "string",
      "body": "string",
      "tags": "string[]",
      "changedAt": "ISO 8601 timestamp"
    }
  ],
  "count": "integer"
}
```

#### POST /notes/:id/restore
Restore a previous version of a note (creates new version)

**Request:**
```json
{
  "versionToRestore": "integer (>= 1)",
  "requestId": "string (uuid)"
}
```

**Response (200 OK):**
```json
{
  "status": "accepted",
  "note": {
    "id": "string (uuid)",
    "title": "string",
    "body": "string",
    "tags": "string[]",
    "version": "integer",
    "updatedAt": "ISO 8601 timestamp",
    "createdAt": "ISO 8601 timestamp"
  },
  "message": "string",
  "restoredVersion": "integer",
  "newVersion": "integer"
}
```

## Example Scenarios

### Non-Conflicting Changes (Merge)
**Scenario**:
- Device A reads note at version 1 (title: "Hello", body: "World")
- Device B reads note at version 1 (title: "Hello", body: "World")
- Device A updates title to "Hi"
- Device B updates body to "Earth"

**Result**:
- Status: "merged"
- Final note: title: "Hi", body: "Earth", version: 3
- Both changes preserved

### Conflicting Changes
**Scenario**:
- Device A reads note at version 1 (title: "Hello", body: "World")
- Device B reads note at version 1 (title: "Hello", body: "World")
- Device A updates title to "Hi"
- Device B updates title to "Hey"

**Result**:
- Status: "conflict"
- Final note: title: "Hey" (server's version preserved), body: "World", version: 3
- Conflicts array shows:
  - Field: "title"
  - Client Value: "Hi"
  - Server Value: "Hey"
  - Base Value: "Hello"
- Device A's change preserved where possible (body unchanged)

### Stale Update Protection
**Scenario**:
- Device A reads note at version 1
- Device B reads note at version 1 and updates it (becomes version 2)
- Device A attempts to update based on version 1

**Result**:
- Status: 422 Unprocessable Entity
- Error: "Client baseVersion is newer than current server version"
- Note remains at version 2 with Device B's changes

## Setup Instructions

### Prerequisites
- Node.js (v18+ recommended)
- PostgreSQL (v12+ recommended)
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```

4. Update `.env` with your PostgreSQL connection details:
   ```
   DATABASE_URL="postgresql://username:password@host:port/database"
   PORT=3000
   NODE_ENV=development
   IDEMPOTENCY_TTL_HOURS=24
   ```

5. The server will automatically initialize the database schema on startup (creates tables if they don't exist)

### Running the Server

```bash
# Development mode
npm start

# Or directly
node src/server.js
```

The server will start on port 3000 (or as configured in PORT environment variable).

### Accessing API Documentation

Once the server is running, visit:
```
http://localhost:3000/api-docs
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Testing Strategy

The test suite covers:

### Basic Behavior
- Note creation and retrieval
- Basic synchronization operations

### Versioning
- Correct initial version assignment
- Proper version incrementing
- Stale version detection

### Conflict Detection
- Same-field conflicts
- Different-field merges (non-conflicting)
- Mixed scenarios (some fields conflict, some don't)
- Multiple device scenarios

### Idempotency
- Duplicate request handling
- Same request ID with identical payload
- Same request ID with different payload (error)
- Expired idempotency records

### Ordering Scenarios
- Out-of-order request handling
- Stale requests after newer updates

### Concurrency
- Parallel synchronization requests
- Race condition prevention
- Simultaneous updates to same note

### Failure Cases
- Invalid UUID formats
- Missing required fields
- Invalid data types
- Negative version numbers
- Non-existent resources
- Database error handling

### Version History (Enhancement)
- Retrieving version history
- Restoring previous versions
- History preservation during restore

## Important Design Decisions

### 1. Database-Backed Idempotency
Instead of in-memory idempotency storage, we use a database table with:
- Persistent storage across server restarts
- Automatic cleanup of expired records
- Protection against duplicate requests in distributed environments
- Payload hash verification to detect idempotency-key misuse

### 2. Separation of Current State and History
- `notes` table: Current state for fast reads
- `note_versions` table: Historical snapshots for change tracking
- This separation provides:
  - Fast access to current state
  - Efficient change detection between versions
  - Foundation for history viewing and restoration features

### 3. Atomic Transactions
All synchronization operations occur within a single database transaction:
- Prevents race conditions
- Ensures consistency between current state and history
- Guarantees that idempotency records are properly updated
- Eliminates partial update scenarios

### 4. Row-Level Locking
Using `SELECT FOR UPDATE` on the note row:
- Prevents concurrent updates to the same note
- Ensures version checking and updating are atomic
- Minimizes lock contention by locking only the specific note being updated

### 5. Preserve-On-Conflict Strategy
When conflicts are detected:
- Non-conflicting client changes are applied
- Server's conflicting changes are preserved
- Client receives detailed conflict information for resolution
- No data is silently lost or overwritten

## Assumptions

1. **Single Source of Truth**: The database is the single source of truth for note state
2. **UUIDv4 Format**: Note IDs and request IDs follow standard UUID format
3. **Reasonable Payload Size**: Note titles, bodies, and tags are reasonably sized (not megabytes of data)
4. **Moderate Concurrency**: While the system handles concurrency well, it's not designed for extremely high-throughput scenarios requiring sharding or clustering
5. **Trust Boundary**: Clients are generally trusted to send well-formed requests (though all input is validated)

## Known Limitations

1. **No Authentication/Authorization**: Current implementation assumes all clients are trusted. For production use, authentication and authorization layers would need to be added.

2. **Limited Conflict Resolution Strategies**: The current implementation uses a "server wins" policy for conflicting fields (preserves server's version). More sophisticated strategies (like merge functions or manual resolution UIs) would need to be implemented client-side.

3. **Horizontal Scaling**: While the database can handle multiple connections, the current implementation assumes a single server instance. For horizontal scaling, additional considerations would be needed for:
   - Shared idempotency record storage (already database-backed)
   - Distributed locking mechanisms (row-level locking works with shared databases)
   - Shared file uploads (if extended to support file attachments)

4. **No Soft Deletes**: Notes are permanently deleted from the system (though version history preserves snapshots until explicitly cleaned up).

## Deployment

The application can be deployed to any Node.js hosting platform that supports PostgreSQL:

1. Ensure PostgreSQL is accessible from the deployment environment
2. Set the `DATABASE_URL` environment variable
3. Set `NODE_ENV=production` for production builds
4. Ensure the PORT environment variable is set or defaults to 3000
5. The server will automatically initialize the database schema on startup (creates tables if they don't exist)

### Deployment Options

#### Direct Server Deployment
```bash
# Install dependencies
npm install

# Set environment variables (example)
export DATABASE_URL="postgresql://user:password@host:port/database"
export PORT=3000
export NODE_ENV=production

# Start the server
npm start
```

#### Docker Deployment
1. Build the Docker image:
   ```bash
   docker build -t offline-sync-conflict .
   ```

2. Run the container:
   ```bash
   docker run -p 3000:3000 \\
     -e DATABASE_URL="postgresql://user:password@host:port/database" \\
     -e NODE_ENV=production \\
     -e PORT=3000 \\
     offline-sync-conflict
   ```

### Example Deployment Platforms
- AWS Elastic Beanstalk
- Google App Engine
- Microsoft Azure App Service
- Heroku
- Docker/Kubernetes
- Traditional VPS

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string (required)
- `PORT`: Server port (defaults to 3000)
- `NODE_ENV`: Environment (development, production, test)
- `IDEMPOTENCY_TTL_HOURS`: Hours to remember request IDs for idempotency (defaults to 24)

### Database Initialization
The server automatically initializes the database schema on startup by creating the required tables if they don't exist:
- `notes`: Current state of notes
- `note_versions`: Historical versions of notes
- `idempotency_records`: Idempotency keys for duplicate request detection

## License

ISC License

## Acknowledgments

This project was built as part of the GDG on Campus SRM 2026-27 recruitment process for the Backend — Offline Sync Conflict task.
