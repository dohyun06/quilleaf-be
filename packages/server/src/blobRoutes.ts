import type { IncomingMessage, ServerResponse } from "node:http";
import { finished, pipeline } from "node:stream/promises";
import { type BlobRoute, MAX_ATTACHMENT_BYTES, parseBlobRoute } from "@quilleaf/shared";
import { BlobHashMismatchError, type BlobStore, BlobTooLargeError } from "./blobStore";
import type { Logger } from "./logger";

const BEARER = /^Bearer (\S+)$/;
const ALLOWED_METHODS = "GET, HEAD, PUT";
const BLOB_CONTENT_TYPE = "application/octet-stream";

export interface BlobRouteDeps {
  blobs: BlobStore;
  resolveVaultId: (token: string) => string | null;
  logger: Logger;
}

/** Handles `[/prefix]/blobs/<vaultId>/<sha256>` (spec 2026-11-23 §4). Returns false for any other path. */
export async function handleBlobRequest(req: IncomingMessage, res: ServerResponse, deps: BlobRouteDeps): Promise<boolean> {
  const route = parseBlobRoute(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!route) return false;
  try {
    await routeAuthorized(req, res, route, deps);
  } catch (error) {
    respondToFailure(req, res, route, deps.logger, error);
  }
  return true;
}

async function routeAuthorized(req: IncomingMessage, res: ServerResponse, route: BlobRoute, deps: BlobRouteDeps): Promise<void> {
  const token = BEARER.exec(req.headers.authorization ?? "")?.[1];
  const vaultId = token ? deps.resolveVaultId(token) : null;
  if (!vaultId) return send(req, res, 401, { "www-authenticate": "Bearer" });
  if (vaultId !== route.vaultId) {
    deps.logger.log("warn", "blob.forbidden", { vaultId: route.vaultId });
    return send(req, res, 403);
  }
  if (req.method === "GET" || req.method === "HEAD") return download(req, res, route, deps.blobs);
  if (req.method === "PUT") return upload(req, res, route, deps);
  send(req, res, 405, { allow: ALLOWED_METHODS });
}

async function download(req: IncomingMessage, res: ServerResponse, route: BlobRoute, blobs: BlobStore): Promise<void> {
  const size = await blobs.size(route.vaultId, route.sha256);
  if (size === null) return send(req, res, 404);
  res.writeHead(200, { "content-type": BLOB_CONTENT_TYPE, "content-length": size });
  if (req.method === "HEAD") return void res.end();
  await pipeline(blobs.openRead(route.vaultId, route.sha256), res);
}

async function upload(req: IncomingMessage, res: ServerResponse, route: BlobRoute, deps: BlobRouteDeps): Promise<void> {
  const declared = req.headers["content-length"];
  if (declared === undefined) return send(req, res, 411);
  if (Number(declared) > MAX_ATTACHMENT_BYTES) return send(req, res, 413);
  const result = await deps.blobs.write(route.vaultId, route.sha256, req, MAX_ATTACHMENT_BYTES);
  if (result === "created") deps.logger.log("info", "blob.stored", { vaultId: route.vaultId, sha256: route.sha256, bytes: Number(declared) });
  // a success must be readable: closing on an unread body resets the client's upload (and gives a 502 behind Caddy)
  else await finished(req.resume());
  send(req, res, result === "created" ? 201 : 200);
}

function respondToFailure(req: IncomingMessage, res: ServerResponse, route: BlobRoute, logger: Logger, error: unknown): void {
  if (error instanceof BlobTooLargeError) return send(req, res, 413);
  if (error instanceof BlobHashMismatchError) {
    logger.log("warn", "blob.hash_mismatch", { vaultId: route.vaultId, sha256: route.sha256 });
    return send(req, res, 422);
  }
  logger.log("error", "blob.failed", { vaultId: route.vaultId, method: req.method ?? null, message: error instanceof Error ? error.message : String(error) });
  if (res.headersSent) return void res.destroy();
  send(req, res, 500);
}

/** A refusal does not drain the body: the connection closes instead (a client sending `Expect: 100-continue` has already been told to send it). */
function send(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (!req.complete) res.setHeader("connection", "close");
  res.writeHead(status, headers).end();
}
