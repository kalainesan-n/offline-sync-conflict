# Offline Sync Conflict

A backend for keeping notes consistent when multiple devices edit them offline. It detects conflicting changes, merges independent edits, and uses PostgreSQL version history and transactions to protect data during synchronization.

**Live demo:** [offline-sync-conflict-1.onrender.com](https://offline-sync-conflict-1.onrender.com)  
**Source code:** [GitHub repository](https://github.com/kalainesan-n/offline-sync-conflict)

Built for the **GDG on Campus SRM 2026–27 recruitment — Backend task**.

## The problem

Imagine two devices open the same note at version 1.

- **Device A** changes the title to `Sync Engine`.
- **Device B** changes the body to `Supports offline editing`.

Both devices reconnect and send their changes to the server. A naive API might overwrite one device's work with the other.

This project handles that situation by comparing each update with the version the client originally saw.

### Three synchronization scenarios

**1. Different fields changed — merge**

Device A changes the title while Device B changes the body. Since the edits do not overlap, the backend can preserve both.

**2. The same field changed — conflict**

Both devices change the title. The backend detects the overlap and preserves the already accepted server value for the conflicting field, rather than silently overwriting it.

**3. An old request is retried — idempotency**

A device sends an update, but the response is lost. When it retries with the same request ID and payload, the backend can return the recorded result instead of applying the same logical operation again.

These cases are the core of the project: preserve compatible edits, identify genuine conflicts, and make retries safe.

## How it works

A synchronization request contains four key values:

- `noteId` identifies the note.
- `baseVersion` identifies the version the client last observed.
- `changes` contains the fields the client wants to update.
- `requestId` identifies the logical request for retry handling.

The backend validates the request, checks for an existing idempotency record, and coordinates access to the note through a PostgreSQL transaction.

It compares the historical base snapshot with the current server state to identify fields changed since the client last synchronized. The incoming changes are then compared with those server-side changes.

Compatible edits can be merged. Overlapping edits are reported as conflicts according to the server-preserving policy. When the accepted state changes, the backend records a new version and stores the request result.

## Architecture and database

The backend uses Node.js, Express, and PostgreSQL, with the `pg` driver for database access.

```text
Client devices
      |
      v
Express API
      |
      v
Validation and idempotency checks
      |
      v
PostgreSQL transaction
      |
      +-- notes
      +-- note_versions
      +-- idempotency_records
      |
      v
Synchronization result
```

The database separates three responsibilities:

| Table | Purpose |
|---|---|
| `notes` | Stores the current state and version of each note. |
| `note_versions` | Stores historical snapshots used for version comparison and restoration. |
| `idempotency_records` | Stores request IDs, payload hashes, and cached response data. |

### Transactions and concurrency

The backend uses `SELECT ... FOR UPDATE` to coordinate concurrent updates to the same note. Related changes to the current note, version history, and idempotency result are handled within a transaction so they can be committed or rolled back together.

Idempotency records also prevent a request ID from being reused with a different payload. The documented retention period is 24 hours.

### Version history and restoration

Historical snapshots allow the backend to compare a client's old state with the latest server state. Restoration uses a previous snapshot as the source for a new current version, preserving the intervening history rather than deleting it.

## Technology stack

- **Runtime:** Node.js
- **API:** Express.js
- **Database:** PostgreSQL
- **Database driver:** `pg`
- **API documentation:** Swagger/OpenAPI
- **Testing:** Jest and Supertest
- **Deployment:** Render and Docker

## API

The project documents the following routes. Check the current Swagger documentation for exact request schemas and response formats.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/notes/sync` | Synchronize note changes |
| `GET` | `/api/notes/:id` | Retrieve the current note |
| `GET` | `/api/notes/:id/versions` | Retrieve version history |
| `POST` | `/api/notes/:id/restore` | Restore a previous version |

**Live API:** [https://offline-sync-conflict-1.onrender.com](https://offline-sync-conflict-1.onrender.com)  
**Swagger UI:** [https://offline-sync-conflict-1.onrender.com/api-docs](https://offline-sync-conflict-1.onrender.com/api-docs)

The root endpoint returns:

```json
{
  "message": "Offline Sync Conflict API"
}
```

This confirms that the deployed server responds. It does not, by itself, verify every synchronization operation.

## Run locally

**Prerequisites:** Node.js, npm, and PostgreSQL.

Clone the repository and install dependencies:

```bash
git clone https://github.com/kalainesan-n/offline-sync-conflict.git
cd offline-sync-conflict
npm install
```

Configure your local database connection in `.env`:

```env
DATABASE_URL=postgresql://username:password@host:port/database
PORT=3000
NODE_ENV=development
```

Use your own database credentials and never commit `.env`.

Start the application:

```bash
npm start
```

Run the automated tests:

```bash
npm test
```

Run database integration tests against a dedicated test database, not a production database containing data you need to preserve.

## Limitations and next steps

The current conflict policy preserves the accepted server value when both sides modify the same field. A client-facing interface for manually resolving conflicts would be a useful next step.

Other improvements include authentication and per-user authorization, soft deletion, more extensive concurrent-load testing, and production monitoring.

## Project details

**Project:** Offline Sync Conflict Backend  
**Recruitment:** GDG on Campus SRM 2026–27  
**Repository:** [kalainesan-n/offline-sync-conflict](https://github.com/kalainesan-n/offline-sync-conflict)  
**Deployment:** [offline-sync-conflict-1.onrender.com](https://offline-sync-conflict-1.onrender.com)

The project focuses on a practical distributed-systems problem: coordinating independent edits without blindly overwriting accepted data.
