# Offline Sync Conflict Backend

**A conflict-aware synchronization backend for applications that need to keep data consistent across multiple devices, even when those devices make changes offline.**

[Live Demo](https://offline-sync-conflict-1.onrender.com) · [GitHub Repository](https://github.com/kalainesan-n/offline-sync-conflict)

---

## Overview

When multiple devices edit the same data while offline, their changes can diverge. When they reconnect, blindly accepting updates can overwrite newer information and cause data loss.

**Offline Sync Conflict** is a Node.js and Express backend designed to detect these conflicts, preserve compatible changes, and return clear synchronization results.

The system uses PostgreSQL-backed version history, optimistic concurrency control, field-level conflict detection, transactional updates, and idempotency to make synchronization safer and more predictable.

The project was developed for the **GDG on Campus SRM 2026–27 recruitment process — Backend: Offline Sync Conflict task**.

## Live Demo

| Resource | Link |
|---|---|
| Live API | https://offline-sync-conflict-1.onrender.com |
| GitHub repository | https://github.com/kalainesan-n/offline-sync-conflict |
| API documentation | https://offline-sync-conflict-1.onrender.com/api-docs |

The root endpoint currently provides a basic availability response:

```json
{
  "message": "Offline Sync Conflict API"
}
```

The root response confirms that the deployed application is reachable. The synchronization endpoints and database operations should be tested separately before claiming complete end-to-end verification.

## Key Features

- **Field-level conflict detection:** Identifies when the client and server have changed the same field since the client's last known version.
- **Automatic merging:** Applies non-conflicting changes whenever possible.
- **Version tracking:** Stores historical snapshots of accepted note states.
- **Stale update protection:** Uses version information to detect outdated client updates.
- **Idempotent requests:** Recognizes duplicate synchronization requests and replays their original results.
- **Payload verification:** Rejects reuse of an idempotency key with a different request payload.
- **Transactional consistency:** Groups synchronization operations into database transactions.
- **Concurrent update protection:** Uses PostgreSQL row-level locking to coordinate updates to the same note.
- **Version history and restoration:** Supports retrieving historical versions and restoring a previous state as a new version.
- **API validation:** Provides structured error responses for invalid requests and unsupported synchronization states.

## Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js |
| HTTP framework | Express.js |
| Database | PostgreSQL |
| Database driver | `pg` |
| API documentation | Swagger/OpenAPI, `swagger-ui-express` |
| Testing | Jest and Supertest |
| Environment configuration | dotenv |
| Deployment | Render and Docker |

## Architecture

```text
Client / Device A       Client / Device B
        |                       |
        +-----------+-----------+
                    |
              Express API
                    |
          Request Validation
                    |
          Idempotency Checking
                    |
       Version and Conflict Detection
                    |
       PostgreSQL Transaction
          /         |          \
       notes   note_versions   idempotency_records
                    |
          Synchronization Result
                    |
               API Response
```

### Database design

The application separates current note state, historical versions, and idempotency records.

**1. `notes` — Current state**

Stores the latest accepted state of each note, including its UUID, title, body, tags, version, and timestamps.

**2. `note_versions` — Historical snapshots**

Stores versioned snapshots of notes. These snapshots allow the backend to compare the client's base version with the current server state and support version history and restoration.

**3. `idempotency_records` — Duplicate request tracking**

Stores request identifiers, payload hashes, cached response status and body, and expiration timestamps. This allows the backend to recognize retries without blindly applying the same update again.

## How Synchronization Works

Each synchronization request identifies the note, the version the client last observed, the requested changes, and a unique request ID.

The backend processes the request through the following stages:

1. **Validate the request.** Check the identifiers, version, and changes.
2. **Check idempotency.** If the request ID and payload match a previously processed request, return the stored result. If the same request ID is reused with a different payload, reject it.
3. **Lock the note row.** Use PostgreSQL transaction locking to coordinate concurrent changes to the same note.
4. **Load the base version.** Retrieve the historical snapshot corresponding to the client's `baseVersion`.
5. **Compare changes.** Determine which fields have changed on the server since that base version.
6. **Resolve conflicts.** Apply compatible client changes and preserve the server's value for conflicting fields.
7. **Update the state and history.** Record a new version when the accepted note state changes.
8. **Persist the result.** Store the idempotency result and return a response describing the outcome.

The objective is to prevent silent overwrites while preserving as much valid work as possible.

## Conflict Resolution Strategy

The backend uses a field-level, preserve-on-conflict strategy.

### Scenario A: Non-conflicting changes

Two devices start with the same note:

```json
{
  "title": "Hello",
  "body": "World"
}
```

Device A changes the title to `Hi`, while Device B changes the body to `Earth`.

Because the devices changed different fields, their changes can be merged:

```json
{
  "title": "Hi",
  "body": "Earth"
}
```

The system preserves both changes.

### Scenario B: Conflicting changes

Two devices edit the same title from the same base version:

- Device A changes the title to `Hi`.
- Device B changes the title to `Hey`.

The backend detects that both changes target the same field. Under the documented policy, the already accepted server value is preserved, and the incoming conflicting value is reported to the client.

The conflict response is intended to include the field name and the base, client, and server values so the client can make an informed decision.

### Scenario C: Stale update

A device reads version 1. Another device updates the note to version 2. The first device later submits an update based on version 1.

The backend detects that the request is based on an older state. Depending on the request and applicable validation rules, the server can reject an invalid or stale version rather than silently overwriting newer accepted data.

## Version History and Restoration

Every accepted state transition that changes the note creates a historical snapshot.

Version history supports:

- Inspecting previous note states.
- Comparing a client's base version with the current server state.
- Detecting changes made by other devices.
- Restoring an earlier state without erasing the history of subsequent changes.

Restoration is designed to create a new version containing the restored content rather than rewriting the existing historical record.

## Idempotency and Concurrency

### Idempotency

Each synchronization request includes a unique `requestId`.

- Same request ID and same payload: return the previously recorded result.
- Same request ID and different payload: reject the request as idempotency-key misuse.
- Expired records: eligible for cleanup according to the configured retention policy.

The documented default retention period is 24 hours.

### Transaction safety

The synchronization process uses PostgreSQL transactions and row-level locking to coordinate updates to the same note.

This helps prevent race conditions where concurrent requests both attempt to update the same state, and it keeps the current note, version history, and idempotency result consistent.

## API Reference

The API uses `/api` as its base prefix. Confirm the deployed API documentation for the exact request and response schemas.

### 1. Synchronize a note

`POST /api/notes/sync`

Example request:

```json
{
  "noteId": "00000000-0000-4000-8000-000000000001",
  "baseVersion": 1,
  "changes": {
    "title": "Updated title"
  },
  "requestId": "00000000-0000-4000-8000-000000000002"
}
```

The response describes the synchronization outcome and the resulting note state. Depending on the implementation, the outcome can be `accepted`, `merged`, or `conflict`.

### 2. Retrieve a note

`GET /api/notes/:id`

Retrieves the current state of a note by its UUID.

### 3. Retrieve version history

`GET /api/notes/:id/versions`

Returns the historical versions associated with a note.

### 4. Restore a previous version

`POST /api/notes/:id/restore`

Example request:

```json
{
  "versionToRestore": 1,
  "requestId": "00000000-0000-4000-8000-000000000003"
}
```

A successful restoration is intended to create a new version containing the selected historical state.

### Error handling

The documented API distinguishes malformed requests, validation failures, version errors, and idempotency-key misuse. Commonly documented status codes include:

- `200 OK` — request processed successfully.
- `400 Bad Request` — malformed or invalid request structure.
- `422 Unprocessable Entity` — validation or version/idempotency rule violation.

Refer to the actual route implementation and API documentation for exact status codes and response bodies.

## Getting Started

### Prerequisites

- Node.js 18 or later.
- PostgreSQL 12 or later.
- npm.

### 1. Clone the repository

```bash
git clone https://github.com/kalainesan-n/offline-sync-conflict.git
cd offline-sync-conflict
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and configure the values for your local environment.

```env
DATABASE_URL=postgresql://username:password@host:port/database
PORT=3000
NODE_ENV=development
IDEMPOTENCY_TTL_HOURS=24
```

Replace the database URL with your own PostgreSQL connection details. Never commit `.env` or publish database credentials.

### 4. Start the server

```bash
npm start
```

The application uses the configured `PORT`, which defaults to 3000 according to the project documentation.

The database schema is initialized by the application at startup. Ensure your database is available and that the configured database user has the required permissions.

### 5. Open API documentation

When running locally, open:

http://localhost:3000/api-docs

If the documentation route is enabled in the deployed application, it can also be accessed at:

https://offline-sync-conflict-1.onrender.com/api-docs

## Testing

The project uses Jest and Supertest for automated testing.

Run the test suite with:

```bash
npm test
```

If supported by the project's npm scripts, run tests in watch mode with:

```bash
npm run test:watch
```

The documented test coverage areas include:

- Basic note creation, retrieval, and synchronization.
- Version assignment and increments.
- Stale update detection.
- Same-field conflicts and different-field merges.
- Duplicate requests and idempotency-key misuse.
- Out-of-order updates.
- Concurrent requests and race conditions.
- Invalid identifiers and request payloads.
- Database error handling.
- Version history and restoration.

**Testing note:** these are the intended coverage areas, not a claim that every test has passed in the current deployment environment. Run tests against a dedicated test database, not a database containing data you need to preserve.

## Deployment

The project is deployed on Render and uses a hosted PostgreSQL database.

**Live API:** https://offline-sync-conflict-1.onrender.com

Deployment configuration requires the appropriate PostgreSQL connection string and environment variables to be configured in the hosting provider's secure environment settings.

The repository includes Docker and hosting configuration files. Keep secrets outside the repository, and ensure production database initialization does not delete existing data.

## Design Decisions

**Optimistic concurrency control:** Clients report the version they last observed, allowing the backend to detect changes made in the meantime.

**Field-level conflict detection:** Conflicts are evaluated per field, allowing independent changes to be merged.

**Database-backed idempotency:** Duplicate request handling survives server restarts and is shared through PostgreSQL rather than being limited to process memory.

**Separate current state and history:** Current reads remain straightforward while historical snapshots support conflict detection, auditing, and restoration.

**Transactional updates:** Current state, version history, and request results are coordinated to reduce inconsistent partial updates.

## Known Limitations

- **No authentication or authorization:** The current implementation does not provide a complete identity and access-control layer. It should not be used for sensitive multi-user data without appropriate security controls.
- **Server-preserving conflict policy:** Conflicting fields retain the accepted server value. A more sophisticated manual conflict-resolution interface would need to be implemented by a client.
- **No soft-delete workflow:** Deleted notes are not managed through a dedicated soft-delete mechanism.
- **Scaling considerations:** High-throughput deployments and multiple service instances require appropriate database connection management, operational monitoring, and further load testing.

## Future Improvements

Potential next steps include:

- Authentication and per-user note authorization.
- A client-side conflict-resolution interface.
- Load testing under concurrent synchronization workloads.
- Monitoring, structured logging, and operational metrics.
- More comprehensive integration testing against a dedicated test database.

## Project Information

**Project:** Offline Sync Conflict Backend  
**Recruitment:** GDG on Campus SRM 2026–27  
**Category:** Backend  
**Repository:** [kalainesan-n/offline-sync-conflict](https://github.com/kalainesan-n/offline-sync-conflict)  
**Live demo:** [offline-sync-conflict-1.onrender.com](https://offline-sync-conflict-1.onrender.com)

The project explores how a backend can handle offline edits from multiple devices while reducing silent overwrites, preserving compatible changes, and making synchronization outcomes explicit.

---

*Built with Node.js, Express, and PostgreSQL.*
