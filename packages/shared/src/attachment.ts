import { EXCLUDED_ATTACHMENT_FILE_NAMES, MAX_ATTACHMENT_BYTES, SYNCABLE_EXTENSION } from "./constants";
import { isValidFileId } from "./docName";
import { isSafeRelativePath } from "./path";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HASH_PREFIX_LENGTH = 6;
const ISO_DATE_LENGTH = 10;

/** Content of an attachment version. Set as one plain value so sha256 and size always change together. */
export interface AttachmentBlob {
  sha256: string;
  size: number;
  /** The sha256 this version replaced on the writing device (null for a new file); detects a lost concurrent write. */
  baseSha256: string | null;
}

/** One value of the index doc's `attachments` map (spec 2026-11-23 §3). */
export interface AttachmentEntry {
  attachmentId: string;
  path: string;
  deleted: boolean;
  createdAt: number;
  blob: AttachmentBlob;
}

/**
 * Every non-markdown file outside hidden folders, except OS metadata. Hidden means any `.`-prefixed segment:
 * `.obsidian/`, `.git/`, `.trash/`, `.leaflet/` (per-device app state), `.DS_Store`, atomic-write temp files.
 * Expects a normalized path.
 */
export function isAttachmentPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  if (path.toLowerCase().endsWith(SYNCABLE_EXTENSION)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return false;
  const name = segments[segments.length - 1]!.toLowerCase();
  return !EXCLUDED_ATTACHMENT_FILE_NAMES.includes(name);
}

export function isWithinAttachmentSizeLimit(size: number): boolean {
  return Number.isInteger(size) && size >= 0 && size <= MAX_ATTACHMENT_BYTES;
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/** WebCrypto, so it runs in Node and in the app's webview alike. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null;
}

function parseBlob(raw: unknown): AttachmentBlob | null {
  if (!isFields(raw)) return null;
  const { sha256, size, baseSha256 } = raw;
  if (typeof sha256 !== "string" || !isSha256Hex(sha256)) return null;
  if (typeof size !== "number" || !isWithinAttachmentSizeLimit(size)) return null;
  if (baseSha256 !== null && (typeof baseSha256 !== "string" || !isSha256Hex(baseSha256))) return null;
  return { sha256, size, baseSha256 };
}

/** Entries come from other devices: validate before trusting them. `raw` is the entry Y.Map's `toJSON()`. */
export function parseAttachmentEntry(attachmentId: string, raw: unknown): AttachmentEntry | null {
  if (!isValidFileId(attachmentId) || !isFields(raw)) return null;
  const { path, deleted, createdAt } = raw;
  if (typeof path !== "string" || !isAttachmentPath(path)) return null;
  if (typeof deleted !== "boolean" || typeof createdAt !== "number") return null;
  if (Number.isNaN(new Date(createdAt).getTime())) return null;
  const blob = parseBlob(raw.blob);
  return blob ? { attachmentId, path, deleted, createdAt, blob } : null;
}

function splitExtension(path: string): { stem: string; extension: string } {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") + 1 ? { stem: path.slice(0, dot), extension: path.slice(dot) } : { stem: path, extension: "" };
}

/** Like the note conflict name (`a (conflict YYYY-MM-DD abcdef).md`), keyed by the losing content's hash. UTC date. */
export function buildAttachmentConflictPath(input: { path: string; timestampMs: number; sha256: string }): string {
  const date = new Date(input.timestampMs).toISOString().slice(0, ISO_DATE_LENGTH);
  const { stem, extension } = splitExtension(input.path);
  return `${stem} (conflict ${date} ${input.sha256.slice(0, HASH_PREFIX_LENGTH)})${extension}`;
}
