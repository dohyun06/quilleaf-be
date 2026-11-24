import { describe, expect, it } from "vitest";
import { PAIR_MAX_PENDING, PAIR_MAX_PENDING_PER_CLIENT } from "@quilleaf/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { runPairCommand } from "../src/pairCommand";
import { PairStore } from "../src/pairStore";
import { runTokenCommand } from "../src/tokenCommand";
import { TokenStore } from "../src/tokenStore";

function setup() {
  const db = openDatabase(":memory:");
  const tokens = new TokenStore(db);
  return { db, tokens, pairs: new PairStore(db, tokens) };
}

describe("PairStore", () => {
  it("caps pending requests per client and overall", () => {
    const { pairs } = setup();
    for (let i = 0; i < PAIR_MAX_PENDING_PER_CLIENT; i++) expect(pairs.request("a", "one")).not.toBeNull();
    expect(pairs.request("a", "one")).toBeNull();
    for (let i = PAIR_MAX_PENDING_PER_CLIENT; i < PAIR_MAX_PENDING; i++) expect(pairs.request("a", `client-${i}`)).not.toBeNull();
    expect(pairs.request("a", "fresh")).toBeNull();
  });

  it("stores only hashes of the code and secret", () => {
    const { db, pairs } = setup();
    const created = pairs.request("Pixel", "203.0.113.7")!;
    const row = db.prepare("SELECT code_hash, secret_hash FROM pair_requests").get() as { code_hash: string; secret_hash: string };
    expect(JSON.stringify(row)).not.toContain(created.code);
    expect(JSON.stringify(row)).not.toContain(created.secret);
  });

  it("normalizes the typed code (case, hyphen, O/I/L)", () => {
    const { pairs } = setup();
    // force a code that has look-alike characters when typed: 0 and 1 may be typed as O and I/L
    const created = pairs.request("Pixel", "203.0.113.7")!;
    const typed = created.code.toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
    expect(pairs.approve(`${typed.slice(0, 4)}-${typed.slice(4)}`, "my-vault-01")).toEqual({ deviceName: "Pixel" });
  });

  it("rejects an invalid vault id on approve", () => {
    const { pairs } = setup();
    const created = pairs.request("Pixel", "203.0.113.7")!;
    expect(() => pairs.approve(created.code, "Bad Vault")).toThrow();
  });
});

describe("tokens.label migration", () => {
  it("adds the column to a database created before pairing and keeps its tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "label-migration-"));
    try {
      const path = join(dir, "old.db");
      const old = new DatabaseSync(path);
      old.exec("CREATE TABLE tokens (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER)");
      old.exec("INSERT INTO tokens VALUES ('t1', 'my-vault-01', 'h', 1, NULL)");
      old.close();
      for (let i = 0; i < 2; i++) {
        const db = openDatabase(path); // the second open must not fail on a duplicate column
        const tokens = new TokenStore(db);
        expect(tokens.list()[0]).toMatchObject({ tokenId: "t1", label: null });
        if (i === 0) tokens.issue("my-vault-01", "Laptop");
        expect(tokens.list().map((t) => t.label)).toEqual([null, "Laptop"]);
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("CLI", () => {
  it("pair approve approves a pending request, then fails for it a second time", () => {
    const { pairs } = setup();
    const created = pairs.request("Pixel", "203.0.113.7")!;
    const lines: string[] = [];
    expect(runPairCommand(["pair", "approve", created.code, "my-vault-01"], pairs, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(["approved"]);
    expect(pairs.claim(created.secret)).toMatchObject({ status: "approved", vaultId: "my-vault-01" });
    expect(runPairCommand(["pair", "approve", created.code, "my-vault-01"], pairs, () => {})).toBe(1);
  });

  it("pair approve reports bad usage and an invalid vault id", () => {
    const { pairs } = setup();
    expect(runPairCommand(["pair", "approve", "ABCDEFGH"], pairs, () => {})).toBe(2);
    expect(runPairCommand(["pair", "approve", "ABCDEFGH", "Bad Vault"], pairs, () => {})).toBe(1);
  });

  it("token create takes a label and token list shows it", () => {
    const { tokens } = setup();
    const lines: string[] = [];
    expect(runTokenCommand(["token", "create", "my-vault-01", "Laptop"], tokens, () => {})).toBe(0);
    runTokenCommand(["token", "list"], tokens, (l) => lines.push(l));
    expect(lines[0]).toMatch(/active {2}Laptop$/);
  });
});