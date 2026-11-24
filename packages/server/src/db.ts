import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  label TEXT
);
CREATE TABLE IF NOT EXISTS pair_requests (
  code_hash TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  vault_id TEXT,
  client_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pair_requests_client ON pair_requests (client_hash);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // the token CLI runs in its own process beside the server; wait for its write lock instead of failing
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  addMissingTokenLabelColumn(db);
  return db;
}

/** Databases created before pairing have no label column; CREATE TABLE IF NOT EXISTS leaves them as they are. */
function addMissingTokenLabelColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "label")) db.exec("ALTER TABLE tokens ADD COLUMN label TEXT");
}
