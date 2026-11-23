import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlobUrl, MAX_ATTACHMENT_BYTES, sha256Hex } from "@quilleaf/shared";
import { BlobStore } from "../src/blobStore";
import { openDatabase } from "../src/db";
import { DocumentStore } from "../src/documentStore";
import { createJsonLogger } from "../src/logger";
import { createSyncServer } from "../src/syncServer";
import { TokenStore } from "../src/tokenStore";

const VAULT = "my-vault-01";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start() {
  const db = openDatabase(":memory:");
  const tokens = new TokenStore(db);
  const root = mkdtempSync(join(tmpdir(), "blob-routes-"));
  const logs: string[] = [];
  const server = createSyncServer({
    port: 0,
    address: "127.0.0.1",
    documents: new DocumentStore(db),
    tokens,
    blobs: new BlobStore(root),
    logger: createJsonLogger((line) => logs.push(line)),
  });
  await server.listen();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => server.destroy());
  const { token } = tokens.issue(VAULT);
  const other = tokens.issue("other-vault-1").token;
  // the proxy forwards /sync/... unchanged, so the tests go through the prefixed URL the app builds
  const urlFor = (sha: string, vaultId = VAULT) => buildBlobUrl(`ws://127.0.0.1:${server.address.port}/sync`, vaultId, sha);
  return { token, other, urlFor, logs };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** fetch cannot send a Content-Length that differs from its body, nor a body without one; this can. */
function rawPut(url: string, headers: Record<string, string>, body: Uint8Array): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "PUT", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("blob endpoints", () => {
  it("uploads, checks and downloads a blob (happy path)", async () => {
    const { token, urlFor, logs } = await start();
    const data = bytes("%PDF-1.7 fake");
    const sha = await sha256Hex(data);
    expect((await fetch(urlFor(sha), { method: "HEAD", headers: auth(token) })).status).toBe(404);
    expect((await fetch(urlFor(sha), { method: "PUT", headers: auth(token), body: data })).status).toBe(201);
    const head = await fetch(urlFor(sha), { method: "HEAD", headers: auth(token) });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(data.length));
    const got = await fetch(urlFor(sha), { headers: auth(token) });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(data);
    expect((await fetch(urlFor(sha), { method: "PUT", headers: auth(token), body: data })).status).toBe(200);
    expect(logs.join("\n")).not.toContain(token);
  });

  it("answers 200 to a large re-upload of a stored blob after reading its body", async () => {
    const { token, urlFor } = await start();
    const data = new Uint8Array(4 * 1024 * 1024).fill(7);
    const sha = await sha256Hex(data);
    expect((await fetch(urlFor(sha), { method: "PUT", headers: auth(token), body: data })).status).toBe(201);
    const headers = { ...auth(token), "content-length": String(data.length) };
    expect(await rawPut(urlFor(sha), headers, data)).toBe(200);
  });

  it("also serves the route without the proxy prefix", async () => {
    const { token, urlFor } = await start();
    const sha = await sha256Hex(bytes("a"));
    const url = urlFor(sha).replace("/sync/", "/");
    expect((await fetch(url, { method: "PUT", headers: auth(token), body: bytes("a") })).status).toBe(201);
  });

  it("rejects missing, unknown and other-vault tokens", async () => {
    const { other, urlFor, logs } = await start();
    const sha = await sha256Hex(bytes("a"));
    expect((await fetch(urlFor(sha))).status).toBe(401);
    expect((await fetch(urlFor(sha), { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(urlFor(sha), { headers: { authorization: "nope" } })).status).toBe(401);
    expect((await fetch(urlFor(sha), { method: "PUT", headers: auth(other), body: bytes("a") })).status).toBe(403);
    expect(logs.join("\n")).not.toContain(other);
  });

  it("refuses content that does not match its hash", async () => {
    const { token, urlFor } = await start();
    const sha = await sha256Hex(bytes("expected"));
    expect((await fetch(urlFor(sha), { method: "PUT", headers: auth(token), body: bytes("other") })).status).toBe(422);
    expect((await fetch(urlFor(sha), { method: "HEAD", headers: auth(token) })).status).toBe(404);
  });

  it("refuses an upload over the limit before reading it, and one without a length", async () => {
    const { token, urlFor } = await start();
    const sha = await sha256Hex(bytes("a"));
    const tooLarge = { ...auth(token), "content-length": String(MAX_ATTACHMENT_BYTES + 1) };
    expect(await rawPut(urlFor(sha), tooLarge, bytes("a"))).toBe(413);
    expect(await rawPut(urlFor(sha), { ...auth(token), "transfer-encoding": "chunked" }, bytes("a"))).toBe(411);
  });

  it("answers 405 to other methods and leaves other paths to Hocuspocus", async () => {
    const { token, urlFor } = await start();
    const sha = await sha256Hex(bytes("a"));
    const deleted = await fetch(urlFor(sha), { method: "DELETE", headers: auth(token) });
    expect(deleted.status).toBe(405);
    expect(deleted.headers.get("allow")).toBe("GET, HEAD, PUT");
    expect((await fetch(urlFor(sha).replace(sha, "x"), { headers: auth(token) })).status).toBe(200);
  });
});
