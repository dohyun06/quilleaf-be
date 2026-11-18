import * as Y from "yjs";
import { buildFileDocName, buildIndexDocName, CONTENT_TEXT_KEY, INDEX_FILES_MAP_KEY } from "@quilleaf/shared";
import { TEST_VAULT_ID } from "./device";
import type { LoopbackHub } from "./loopback";

/** Fixed file ids, so a test controls the order in which every device applies index entries. */
export const orderedFileId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Writes the server index directly, as another client (an older plugin, quilleaf) would. */
export class RawIndexClient {
  constructor(private readonly hub: LoopbackHub) {}

  create(fileId: string, path: string, text: string): void {
    this.hub.serverDoc(buildFileDocName(TEST_VAULT_ID, fileId)).getText(CONTENT_TEXT_KEY).insert(0, text);
    this.files().doc!.transact(() => {
      const entry = new Y.Map<unknown>();
      this.files().set(fileId, entry);
      entry.set("path", path);
      entry.set("deleted", false);
      entry.set("createdAt", Date.UTC(2026, 9, 7, 12));
    });
  }

  rename(fileId: string, path: string): void {
    this.files().get(fileId)!.set("path", path);
  }

  delete(fileId: string): void {
    this.files().get(fileId)!.set("deleted", true);
  }

  entry(fileId: string): { path: unknown; deleted: unknown } {
    const raw = this.files().get(fileId)!;
    return { path: raw.get("path"), deleted: raw.get("deleted") };
  }

  private files(): Y.Map<Y.Map<unknown>> {
    return this.hub.serverDoc(buildIndexDocName(TEST_VAULT_ID)).getMap(INDEX_FILES_MAP_KEY);
  }
}
