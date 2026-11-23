import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { InvalidDocNameError, sha256Hex } from "@quilleaf/shared";
import { BlobHashMismatchError, BlobStore, BlobTooLargeError } from "../src/blobStore";

const VAULT = "my-vault-01";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): { store: BlobStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "blobs-"));
  dirs.push(root);
  return { store: new BlobStore(root), root };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("BlobStore", () => {
  it("stores a blob under <vault>/<sha256> and reads it back", async () => {
    const { store, root } = tempStore();
    const data = bytes("png bytes");
    const sha = await sha256Hex(data);
    expect(await store.size(VAULT, sha)).toBeNull();
    expect(await store.write(VAULT, sha, Readable.from([data]), 100)).toBe("created");
    expect(await store.size(VAULT, sha)).toBe(data.length);
    expect(readFileSync(join(root, VAULT, sha))).toEqual(Buffer.from(data));
    const chunks: Buffer[] = [];
    for await (const chunk of store.openRead(VAULT, sha)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(data));
  });

  it("is idempotent for the same content", async () => {
    const { store, root } = tempStore();
    const data = bytes("same");
    const sha = await sha256Hex(data);
    await store.write(VAULT, sha, Readable.from([data]), 100);
    expect(await store.write(VAULT, sha, Readable.from([data]), 100)).toBe("exists");
    expect(readdirSync(join(root, VAULT))).toEqual([sha]);
  });

  it("refuses content whose hash differs and leaves nothing behind", async () => {
    const { store, root } = tempStore();
    const sha = await sha256Hex(bytes("expected"));
    await expect(store.write(VAULT, sha, Readable.from([bytes("other")]), 100)).rejects.toBeInstanceOf(BlobHashMismatchError);
    expect(await store.size(VAULT, sha)).toBeNull();
    expect(readdirSync(join(root, VAULT))).toEqual([]);
  });

  it("stops reading past the size limit and leaves nothing behind", async () => {
    const { store, root } = tempStore();
    const data = bytes("0123456789");
    const sha = await sha256Hex(data);
    await expect(store.write(VAULT, sha, Readable.from([data.slice(0, 6), data.slice(6)]), 9)).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(readdirSync(join(root, VAULT))).toEqual([]);
    expect(await store.write(VAULT, sha, Readable.from([data]), 10)).toBe("created");
  });

  it("keeps vaults apart and validates names, so no path can leave the store", async () => {
    const { store } = tempStore();
    const data = bytes("x");
    const sha = await sha256Hex(data);
    await store.write(VAULT, sha, Readable.from([data]), 10);
    expect(await store.size("other-vault-1", sha)).toBeNull();
    await expect(store.size("../etc", sha)).rejects.toBeInstanceOf(InvalidDocNameError);
    await expect(store.size(VAULT, "../../sync.db")).rejects.toBeInstanceOf(InvalidDocNameError);
    expect(() => store.openRead(VAULT, "x")).toThrow(InvalidDocNameError);
  });
});
