-- Database schema initialization (safe and idempotent - preserves existing data)

-- Notes table: stores current state of notes
CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Note versions table: stores accepted historical snapshots
CREATE TABLE IF NOT EXISTS note_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Idempotency records table: provides persistent idempotency
CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(255) NOT NULL UNIQUE,
    payload_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of the payload
    result_status INTEGER, -- HTTP status code (NULL indicates request is being processed)
    result_body JSONB, -- The response body stored as JSON
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_notes_version ON notes(version);
CREATE INDEX IF NOT EXISTS idx_note_versions_note_id ON note_versions(note_id);
CREATE INDEX IF NOT EXISTS idx_note_versions_version ON note_versions(version);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_request_id ON idempotency_records(request_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at ON idempotency_records(expires_at);