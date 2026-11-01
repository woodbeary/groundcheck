-- The write-ahead ledger for attaching documents to an Encompass eFolder, and the durable inbox
-- for webhook notifications. A row is written before any request it describes.

CREATE TABLE attach_ledger (
  loan_guid      TEXT    NOT NULL,
  sha256         TEXT    NOT NULL,
  container      TEXT    NOT NULL,
  attempt        INTEGER NOT NULL,
  title_tag      TEXT    NOT NULL,
  file_name      TEXT    NOT NULL,
  state          TEXT    NOT NULL CHECK (state IN ('pending', 'submitted', 'confirmed', 'unconfirmed_never_resubmitted')),
  attachment_id  TEXT,
  requested_by   TEXT    NOT NULL,
  note           TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (loan_guid, sha256, container, attempt)
);

CREATE TABLE review_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  queue       TEXT NOT NULL,
  loan_guid   TEXT NOT NULL,
  sha256      TEXT,
  container   TEXT,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE inbox (
  source       TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  body         TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (source, request_id)
);
