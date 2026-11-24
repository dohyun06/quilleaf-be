import { afterEach, describe, expect, it } from "vitest";
import { buildPairUrl, PAIR_MAX_PENDING, PAIR_TTL_MS } from "@quilleaf/shared";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../src/blobStore";
import { openDatabase } from "../src/db";
import { DocumentStore } from "../src/documentStore";
import { createJsonLogger } from "../src/logger";
import { PairStore } from "../src/pairStore";
import { createSyncServer } from "../src/syncServer";
import { TokenStore } from "../src/tokenStore";

const VAULT = "my-vault-01";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start() {
  const db = openDatabase(":memory:");
  let time = 1_000_000;
  const tokens = new TokenStore(db, () => time);
  const server = createSyncServer({
    port: 0,
    address: "127.0.0.1",
    documents: new DocumentStore(db),
    tokens,
    blobs: new BlobStore(join(tmpdir(), "quilleaf-unused-blobs")),
    pairs: new PairStore(db, tokens, () => time),
    logger: createJsonLogger((line) => logs.push(line)),
  });
  const logs: string[] = [];
  await server.listen();
  cleanups.push(() => server.destroy());
  const serverUrl = `ws://127.0.0.1:${server.address.port}/sync`;
  const post = (action: "request" | "approve" | "claim", body: unknown, token?: string) =>
    fetch(buildPairUrl(serverUrl, action), {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const advance = (ms: number) => void (time += ms);
  return { tokens, post, advance, logs, serverUrl };
}

type Started = Awaited<ReturnType<typeof start>>;
async function requestPair(s: Started, deviceName = "Pixel 9") {
  const res = await s.post("request", { deviceName });
  const body = res.status === 201 ? await res.json() : null;
  return { res, body: body as { code: string; secret: string; expiresAt: number } };
}

describe("pairing endpoints", () => {
  it("pairs a device: request, approve, claim returns a working token (happy path)", async () => {
    const s = await start();
    const { res, body } = await requestPair(s);
    expect(res.status).toBe(201);
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.expiresAt).toBe(1_000_000 + PAIR_TTL_MS);

    expect((await s.post("claim", { secret: body.secret })).status).toBe(202);

    const { token: approver } = s.tokens.issue(VAULT);
    const typed = `${body.code.slice(0, 4)}-${body.code.slice(4)}`.toLowerCase();
    const approved = await s.post("approve", { code: typed }, approver);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ deviceName: "Pixel 9" });
    expect((await s.post("approve", { code: body.code }, approver)).status).toBe(404);

    const claimed = await s.post("claim", { secret: body.secret });
    expect(claimed.status).toBe(200);
    const issued = (await claimed.json()) as { vaultId: string; token: string };
    expect(issued.vaultId).toBe(VAULT);
    expect(s.tokens.resolveVaultId(issued.token)).toBe(VAULT);
    expect(s.tokens.list().find((t) => t.label === "Pixel 9")?.vaultId).toBe(VAULT);
    expect((await s.post("claim", { secret: body.secret })).status).toBe(404);

    const logs = s.logs.join("\n");
    for (const secretValue of [body.code, body.secret, issued.token, approver, "Pixel 9"]) expect(logs).not.toContain(secretValue);
    expect(logs).toContain("pair.requested");
    expect(logs).toContain("pair.approved");
    expect(logs).toContain("pair.claimed");
  });

  it("also serves the routes without the proxy prefix", async () => {
    const s = await start();
    const res = await fetch(buildPairUrl(s.serverUrl, "request").replace("/sync/", "/"), { method: "POST", body: '{"deviceName":"x"}' });
    expect(res.status).toBe(201);
  });

  it("answers 404 to an expired request, for approve and claim", async () => {
    const s = await start();
    const { body } = await requestPair(s);
    const { token } = s.tokens.issue(VAULT);
    s.advance(PAIR_TTL_MS);
    expect((await s.post("approve", { code: body.code }, token)).status).toBe(404);
    expect((await s.post("claim", { secret: body.secret })).status).toBe(404);
  });

  it("answers 429 at the pending cap and recovers after expiry", async () => {
    const s = await start();
    for (let i = 0; i < PAIR_MAX_PENDING; i++) expect((await requestPair(s)).res.status).toBe(201);
    expect((await requestPair(s)).res.status).toBe(429);
    s.advance(PAIR_TTL_MS);
    expect((await requestPair(s)).res.status).toBe(201);
  });

  it("rejects approve without a valid token with 401 and leaves the request pending", async () => {
    const s = await start();
    const { body } = await requestPair(s);
    expect((await s.post("approve", { code: body.code })).status).toBe(401);
    expect((await s.post("approve", { code: body.code }, "nope")).status).toBe(401);
    expect((await s.post("claim", { secret: body.secret })).status).toBe(202);
  });

  it("answers 404 for an unknown code or secret", async () => {
    const s = await start();
    const { token } = s.tokens.issue(VAULT);
    expect((await s.post("approve", { code: "ABCD-EFGH" }, token)).status).toBe(404);
    expect((await s.post("approve", { code: "nonsense" }, token)).status).toBe(404);
    expect((await s.post("claim", { secret: "nope" })).status).toBe(404);
  });

  it("answers 400 to bad JSON and wrong field types, 413 over 1 KiB", async () => {
    const s = await start();
    expect((await s.post("request", "{not json")).status).toBe(400);
    expect((await s.post("request", "[]")).status).toBe(400);
    expect((await s.post("request", { deviceName: 5 })).status).toBe(400);
    expect((await s.post("request", { deviceName: "  " })).status).toBe(400);
    expect((await s.post("request", { deviceName: "a\nb" })).status).toBe(400);
    expect((await s.post("claim", {})).status).toBe(400);
    expect((await s.post("request", { deviceName: "x".repeat(2000) })).status).toBe(413);
  });

  it("answers 405 to other methods", async () => {
    const s = await start();
    const res = await fetch(buildPairUrl(s.serverUrl, "request"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});