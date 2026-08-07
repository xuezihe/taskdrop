CREATE TABLE handoffs (
  space_id        bytea       NOT NULL,
  code            text        NOT NULL,
  latest_revision smallint    NOT NULL,
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (space_id, code),
  CONSTRAINT handoffs_space_id_length CHECK (length(space_id) = 32),
  CONSTRAINT handoffs_code_format CHECK (code ~ '^[A-Z0-9]{6}$')
);

CREATE TABLE revisions (
  space_id        bytea       NOT NULL,
  handoff_code    text        NOT NULL,
  revision        smallint    NOT NULL,
  markdown        text        NOT NULL,
  created_at      timestamptz NOT NULL,
  redaction_count integer     NOT NULL,
  PRIMARY KEY (space_id, handoff_code, revision),
  CONSTRAINT revisions_space_id_length CHECK (length(space_id) = 32),
  CONSTRAINT revisions_handoff_code_format CHECK (handoff_code ~ '^[A-Z0-9]{6}$'),
  CONSTRAINT revisions_revision_range CHECK (revision >= 1 AND revision <= 25),
  CONSTRAINT revisions_redaction_count_nonneg CHECK (redaction_count >= 0),
  FOREIGN KEY (space_id, handoff_code)
    REFERENCES handoffs (space_id, code)
    ON DELETE CASCADE
);

CREATE INDEX handoffs_expires_at_idx ON handoffs (expires_at);
