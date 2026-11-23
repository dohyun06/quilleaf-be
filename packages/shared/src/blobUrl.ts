import { isSha256Hex } from "./attachment";
import { BLOB_ROUTE_SEGMENT } from "./constants";
import { InvalidDocNameError, isValidVaultId } from "./docName";

const HTTP_PROTOCOL_FOR: Readonly<Record<string, string>> = { "wss:": "https:", "ws:": "http:" };
const BLOB_ROUTE = new RegExp(`(?:^|/)${BLOB_ROUTE_SEGMENT}/([a-z0-9-]{8,64})/([0-9a-f]{64})$`);

export interface BlobRoute {
  vaultId: string;
  sha256: string;
}

/**
 * The blob endpoint under the sync server URL the user entered: `wss://host/sync` → `https://host/sync/blobs/<vault>/<sha>`.
 * The proxy keeps the `/sync` prefix, and the server accepts the route under any prefix.
 */
export function buildBlobUrl(serverUrl: string, vaultId: string, sha256: string): string {
  if (!isValidVaultId(vaultId)) throw new InvalidDocNameError(`invalid vault id: ${vaultId}`);
  if (!isSha256Hex(sha256)) throw new InvalidDocNameError(`invalid sha256: ${sha256}`);
  const url = new URL(serverUrl);
  const protocol = HTTP_PROTOCOL_FOR[url.protocol];
  if (!protocol) throw new InvalidDocNameError(`not a WebSocket URL: ${serverUrl}`);
  const base = url.pathname.replace(/\/+$/, "");
  return `${protocol}//${url.host}${base}/${BLOB_ROUTE_SEGMENT}/${vaultId}/${sha256}`;
}

/** Expects a URL pathname (no query). */
export function parseBlobRoute(pathname: string): BlobRoute | null {
  const match = BLOB_ROUTE.exec(pathname);
  return match ? { vaultId: match[1]!, sha256: match[2]! } : null;
}
