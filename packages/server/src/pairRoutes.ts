import type { IncomingMessage, ServerResponse } from "node:http";
import { PAIR_MAX_BODY_BYTES, PAIR_MAX_DEVICE_NAME_LENGTH, type PairAction, parsePairRoute } from "@quilleaf/shared";
import type { Logger } from "./logger";
import type { PairStore } from "./pairStore";

const BEARER = /^Bearer (\S+)$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface PairRouteDeps {
  pairs: PairStore;
  resolveVaultId: (token: string) => string | null;
  logger: Logger;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
  }
}

/** Handles `[/prefix]/pair`, `/pair/approve`, `/pair/claim` (spec 2026-11-24). Returns false for any other path. */
export async function handlePairRequest(req: IncomingMessage, res: ServerResponse, deps: PairRouteDeps): Promise<boolean> {
  const action = parsePairRoute(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!action) return false;
  try {
    if (req.method !== "POST") send(req, res, 405, { allow: "POST" });
    else await route(req, res, action, deps);
  } catch (error) {
    respondToFailure(req, res, deps.logger, error);
  }
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse, action: PairAction, deps: PairRouteDeps): Promise<void> {
  if (action === "approve") {
    const token = BEARER.exec(req.headers.authorization ?? "")?.[1];
    const vaultId = token ? deps.resolveVaultId(token) : null;
    if (!vaultId) return send(req, res, 401, { "www-authenticate": "Bearer" });
    return approve(req, res, vaultId, deps);
  }
  const body = await readJsonObject(req);
  if (action === "request") return request(req, res, body, deps);
  return claim(req, res, body, deps);
}

async function approve(req: IncomingMessage, res: ServerResponse, vaultId: string, deps: PairRouteDeps): Promise<void> {
  const code = requireString((await readJsonObject(req)).code);
  const approved = deps.pairs.approve(code, vaultId);
  if (!approved) return send(req, res, 404);
  deps.logger.log("info", "pair.approved", { vaultId });
  sendJson(req, res, 200, { deviceName: approved.deviceName });
}

function request(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, deps: PairRouteDeps): void {
  const deviceName = requireString(body.deviceName).trim();
  if (deviceName.length === 0 || deviceName.length > PAIR_MAX_DEVICE_NAME_LENGTH || CONTROL_CHARACTERS.test(deviceName)) {
    throw new HttpStatusError(400);
  }
  const created = deps.pairs.request(deviceName);
  if (!created) {
    deps.logger.log("warn", "pair.rejected", { reason: "too-many-pending" });
    return send(req, res, 429);
  }
  deps.logger.log("info", "pair.requested");
  sendJson(req, res, 201, created);
}

function claim(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, deps: PairRouteDeps): void {
  const result = deps.pairs.claim(requireString(body.secret));
  if (!result) return send(req, res, 404);
  if (result.status === "pending") return send(req, res, 202);
  deps.logger.log("info", "pair.claimed", { vaultId: result.vaultId, tokenId: result.tokenId });
  sendJson(req, res, 200, { vaultId: result.vaultId, token: result.token });
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new HttpStatusError(400);
  return value;
}

/** Reads at most PAIR_MAX_BODY_BYTES; stops reading (without destroying the socket) once over. */
function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= PAIR_MAX_BODY_BYTES) return void chunks.push(chunk);
      req.off("data", onData);
      req.pause();
      reject(new HttpStatusError(413));
    };
    req.on("data", onData);
    req.on("error", reject);
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpStatusError(400);
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof HttpStatusError ? error : new HttpStatusError(400));
      }
    });
  });
}

function respondToFailure(req: IncomingMessage, res: ServerResponse, logger: Logger, error: unknown): void {
  if (error instanceof HttpStatusError) return send(req, res, error.status);
  logger.log("error", "pair.failed", { message: error instanceof Error ? error.message : String(error) });
  if (res.headersSent) return void res.destroy();
  send(req, res, 500);
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  if (!req.complete) res.setHeader("connection", "close");
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** A refusal does not drain the body: the connection closes instead. */
function send(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (!req.complete) res.setHeader("connection", "close");
  res.writeHead(status, headers).end();
}