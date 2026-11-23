import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { InvalidDocNameError, isSha256Hex, isValidVaultId } from "@quilleaf/shared";

export class BlobTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`blob exceeds ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}

export class BlobHashMismatchError extends Error {
  constructor() {
    super("blob content does not match its sha256");
    this.name = "BlobHashMismatchError";
  }
}

export type BlobWriteResult = "created" | "exists";

/** Content-addressed files at `<root>/<vaultId>/<sha256>`. Both names are validated, so no path leaves the root. */
export class BlobStore {
  constructor(private readonly root: string) {}

  /** Byte size, or null when the blob is not stored. */
  async size(vaultId: string, sha256: string): Promise<number | null> {
    try {
      return (await stat(this.pathFor(vaultId, sha256))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  openRead(vaultId: string, sha256: string): ReadStream {
    return createReadStream(this.pathFor(vaultId, sha256));
  }

  /**
   * Streams into a temp file beside the target while hashing, then renames it into place, so a reader never sees a
   * partial blob. Concurrent uploads of one blob each use their own temp file; the rename of equal bytes is harmless.
   * shortcut: a crash mid-upload leaves its `.tmp` file behind; sweep them at startup if that ever happens.
   */
  async write(vaultId: string, sha256: string, body: Readable, maxBytes: number): Promise<BlobWriteResult> {
    const target = this.pathFor(vaultId, sha256);
    if ((await this.size(vaultId, sha256)) !== null) return "exists";
    await mkdir(join(this.root, vaultId), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    try {
      await pipeline(body, limitAndHash(hash, maxBytes), createWriteStream(temp, { flags: "wx" }));
      if (hash.digest("hex") !== sha256) throw new BlobHashMismatchError();
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return "created";
  }

  private pathFor(vaultId: string, sha256: string): string {
    if (!isValidVaultId(vaultId)) throw new InvalidDocNameError(`invalid vault id: ${vaultId}`);
    if (!isSha256Hex(sha256)) throw new InvalidDocNameError(`invalid sha256: ${sha256}`);
    return join(this.root, vaultId, sha256);
  }
}

function limitAndHash(hash: ReturnType<typeof createHash>, maxBytes: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new BlobTooLargeError(maxBytes));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}
