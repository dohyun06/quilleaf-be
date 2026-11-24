import { InvalidDocNameError } from "./docName";
import { httpBaseUrl } from "./blobUrl";

/** Path segments of the device pairing endpoints, appended to the server URL's path. */
export const PAIR_ROUTE_SEGMENT = "pair";
export const PAIR_APPROVE_SEGMENT = "approve";
export const PAIR_CLAIM_SEGMENT = "claim";
export const PAIR_CODE_LENGTH = 8;
/** Crockford base32: no I, L, O, U. */
export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_TTL_MS = 10 * 60_000;
export const PAIR_MAX_PENDING = 20;
export const PAIR_MAX_BODY_BYTES = 1024;
export const PAIR_MAX_DEVICE_NAME_LENGTH = 100;

export type PairAction = "request" | "approve" | "claim";

const PAIR_ROUTE = new RegExp(`(?:^|/)${PAIR_ROUTE_SEGMENT}(?:/(${PAIR_APPROVE_SEGMENT}|${PAIR_CLAIM_SEGMENT}))?$`);
const PAIR_CODE = new RegExp(`^[${PAIR_CODE_ALPHABET}]{${PAIR_CODE_LENGTH}}$`);
const CODE_SEPARATORS = /[\s-]/g;
const LOOKALIKES: Readonly<Record<string, string>> = { O: "0", I: "1", L: "1" };

/** `wss://host/sync` → `https://host/sync/pair`, `/pair/approve` or `/pair/claim`. */
export function buildPairUrl(serverUrl: string, action: PairAction): string {
  const base = `${httpBaseUrl(serverUrl)}/${PAIR_ROUTE_SEGMENT}`;
  if (action === "request") return base;
  if (action === "approve") return `${base}/${PAIR_APPROVE_SEGMENT}`;
  if (action === "claim") return `${base}/${PAIR_CLAIM_SEGMENT}`;
  throw new InvalidDocNameError(`unknown pair action: ${String(action)}`);
}

/** Expects a URL pathname (no query). The route works under any proxy prefix. */
export function parsePairRoute(pathname: string): PairAction | null {
  const match = PAIR_ROUTE.exec(pathname);
  return match ? ((match[1] as PairAction | undefined) ?? "request") : null;
}

/** Ignores case, spaces and hyphens; reads O as 0 and I/L as 1. Returns null when it is not a code. */
export function normalizePairCode(input: string): string | null {
  const upper = input.replace(CODE_SEPARATORS, "").toUpperCase().replace(/[OIL]/g, (c) => LOOKALIKES[c]!);
  return PAIR_CODE.test(upper) ? upper : null;
}

/** `K7QM2XPA` → `K7QM-2XPA`. */
export function formatPairCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}