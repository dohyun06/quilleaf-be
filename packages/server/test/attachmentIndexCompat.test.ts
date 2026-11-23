import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { INDEX_ATTACHMENTS_MAP_KEY, INDEX_FILES_MAP_KEY, parseAttachmentEntry } from "@quilleaf/shared";

const ATTACHMENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FILE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

describe("attachments map in the index doc (spec 2026-11-23 §8)", () => {
  it("survives a round trip through a client that only opens the files map", () => {
    const fresh = new Y.Doc();
    fresh.transact(() => {
      const entry = new Y.Map<unknown>();
      fresh.getMap(INDEX_ATTACHMENTS_MAP_KEY).set(ATTACHMENT_ID, entry);
      entry.set("path", "img/a.png");
      entry.set("deleted", false);
      entry.set("createdAt", 1);
      entry.set("blob", { sha256: "a".repeat(64), size: 3, baseSha256: null });
    });

    // an old client: receives the state, opens only `files`, edits it, and its whole state is stored again
    const old = new Y.Doc();
    sync(fresh, old);
    const note = new Y.Map<unknown>();
    old.getMap(INDEX_FILES_MAP_KEY).set(FILE_ID, note);
    note.set("path", "a.md");

    const stored = new Y.Doc();
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(old));
    const raw = stored.getMap<Y.Map<unknown>>(INDEX_ATTACHMENTS_MAP_KEY).get(ATTACHMENT_ID);
    expect(parseAttachmentEntry(ATTACHMENT_ID, raw?.toJSON())?.path).toBe("img/a.png");
    expect(stored.getMap(INDEX_FILES_MAP_KEY).has(FILE_ID)).toBe(true);
  });
});
