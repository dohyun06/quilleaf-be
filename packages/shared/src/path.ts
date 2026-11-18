import { EXCLUDED_PATH_PREFIXES, MAX_SYNC_FILE_BYTES, SYNCABLE_EXTENSION } from "./constants";

const LEADING_SEPARATORS = /^(?:\.\/|\/)+/;

/** Unifies separators only. Unicode normalization is intentionally left alone (spec §3.4). */
export function normalizeVaultPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(LEADING_SEPARATORS, "");
}

const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/**
 * Index entries pass this before any device uses them. It must not narrow while older clients and quilleaf sync
 * other names: a device that stops reading an entry it tracks can delete or orphan that note (see isWindowsSafePath).
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes("\0")) return false;
  if (path.startsWith("/") || WINDOWS_DRIVE.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Windows reads `\` as a separator and `:` as a drive or stream marker, and drops trailing dots and spaces (`.. ` is `..`). */
const WINDOWS_UNSAFE_CHARACTER = /[\\:]/;
const TRAILING_DOT_OR_SPACE = /[. ]$/;

/** Whether Windows writes the path as the same file, inside the vault; a Windows device checks it before every write. */
export function isWindowsSafePath(path: string): boolean {
  if (WINDOWS_UNSAFE_CHARACTER.test(path)) return false;
  return path.split("/").every((segment) => !TRAILING_DOT_OR_SPACE.test(segment));
}

/**
 * Comparison key only (stored paths stay unnormalized, spec §3.4): case-insensitive file systems (macOS, iOS,
 * Windows) treat paths differing in letter case, and on APFS in NFC/NFD form, as the same file.
 */
export function foldPathCase(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Expects a normalized path. */
export function isSyncablePath(path: string, extraExcludedPrefixes: readonly string[] = []): boolean {
  if (!isSafeRelativePath(path)) return false;
  if (!path.toLowerCase().endsWith(SYNCABLE_EXTENSION)) return false;
  const folded = foldPathCase(path);
  const excluded = [...EXCLUDED_PATH_PREFIXES, ...extraExcludedPrefixes];
  return !excluded.some((prefix) => folded.startsWith(foldPathCase(prefix)));
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isWithinSizeLimit(text: string): boolean {
  return utf8ByteLength(text) <= MAX_SYNC_FILE_BYTES;
}
