import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidVaultId,
  normalizePairCode,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_MAX_PENDING,
  PAIR_MAX_PENDING_PER_CLIENT,
  PAIR_TTL_MS,
} from "@quilleaf/shared";
import { hashToken, InvalidVaultIdError, type IssuedToken, type TokenStore } from "./tokenStore";

const SECRET_BYTES = 32;
const CODE_ATTEMPTS = 5;

export interface PairRequest {
  code: string;
  secret: string;
  expiresAt: number;
}

export type ClaimResult = { status: "pending" } | ({ status: "approved" } & IssuedToken);

interface PairRow {
  code_hash: string;
  device_name: string;
  vault_id: string | null;
}

/** 5 bits per random byte: the alphabet has 32 symbols, so the choice is unbiased. */
function generateCode(): string {
  return Array.from(randomBytes(PAIR_CODE_LENGTH), (byte) => PAIR_CODE_ALPHABET[byte & 31]).join("");
}

/** Pending device pairing requests (spec 2026-11-24). Codes and secrets are stored as hashes only. */
export class PairStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tokens: TokenStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Null while the client already has PAIR_MAX_PENDING_PER_CLIENT, or everyone PAIR_MAX_PENDING, unexpired requests. */
  request(deviceName: string, client: string): PairRequest | null {
    this.purgeExpired();
    const clientHash = hashToken(client);
    const count = (sql: string, ...params: string[]) => (this.db.prepare(sql).get(...params) as { n: number }).n;
    if (count("SELECT COUNT(*) AS n FROM pair_requests WHERE client_hash = ?", clientHash) >= PAIR_MAX_PENDING_PER_CLIENT) return null;
    if (count("SELECT COUNT(*) AS n FROM pair_requests") >= PAIR_MAX_PENDING) return null;
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + PAIR_TTL_MS;
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = generateCode();
      const result = this.db
        .prepare("INSERT OR IGNORE INTO pair_requests (code_hash, secret_hash, device_name, created_at, expires_at, vault_id, client_hash) VALUES (?, ?, ?, ?, ?, NULL, ?)")
        .run(hashToken(code), hashToken(secret), deviceName, createdAt, expiresAt, clientHash);
      if (Number(result.changes) > 0) return { code, secret, expiresAt };
    }
    throw new Error("could not allocate a pairing code");
  }

  /** Records the vault on a pending request. Null when the code is unknown, expired or already approved. */
  approve(code: string, vaultId: string): { deviceName: string } | null {
    if (!isValidVaultId(vaultId)) throw new InvalidVaultIdError(vaultId);
    const normalized = normalizePairCode(code);
    if (!normalized) return null;
    // one statement: the CLI approves from another process, so a read-then-write could overwrite a concurrent approval
    const row = this.db
      .prepare("UPDATE pair_requests SET vault_id = ? WHERE code_hash = ? AND vault_id IS NULL AND expires_at > ? RETURNING device_name")
      .get(vaultId, hashToken(normalized), this.now()) as { device_name: string } | undefined;
    return row ? { deviceName: row.device_name } : null;
  }

  /** Null when the secret is unknown or expired. An approved request is consumed: the token is returned once. */
  claim(secret: string): ClaimResult | null {
    this.purgeExpired();
    const row = this.db
      .prepare("SELECT code_hash, device_name, vault_id FROM pair_requests WHERE secret_hash = ?")
      .get(hashToken(secret)) as PairRow | undefined;
    if (!row) return null;
    if (row.vault_id === null) return { status: "pending" };
    this.db.prepare("DELETE FROM pair_requests WHERE code_hash = ?").run(row.code_hash);
    return { status: "approved", ...this.tokens.issue(row.vault_id, row.device_name) };
  }

  private purgeExpired(): void {
    this.db.prepare("DELETE FROM pair_requests WHERE expires_at <= ?").run(this.now());
  }
}