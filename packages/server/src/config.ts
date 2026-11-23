import { dirname, join } from "node:path";

const DEFAULT_PORT = 1234;
const DEFAULT_ADDRESS = "127.0.0.1";
const DEFAULT_DB_PATH = "./data/sync.db";
const BLOB_DIR_NAME = "blobs";
const MAX_PORT = 65_535;

export interface ServerConfig {
  port: number;
  address: string;
  dbPath: string;
  /** Attachment blobs; defaults to `blobs/` beside the database, so the existing data volume holds them. */
  blobDir: string;
}

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigError";
  }
}

export function readServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const port = env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new InvalidConfigError(`PORT must be an integer between 1 and ${MAX_PORT}, got "${env.PORT}"`);
  }
  const dbPath = env.DB_PATH ?? DEFAULT_DB_PATH;
  return { port, address: env.HOST ?? DEFAULT_ADDRESS, dbPath, blobDir: env.BLOB_DIR ?? join(dirname(dbPath), BLOB_DIR_NAME) };
}
