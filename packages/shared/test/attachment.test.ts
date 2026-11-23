import { describe, expect, it } from "vitest";
import {
  buildAttachmentConflictPath,
  isAttachmentPath,
  isSha256Hex,
  isWithinAttachmentSizeLimit,
  MAX_ATTACHMENT_BYTES,
  parseAttachmentEntry,
  sha256Hex,
} from "@quilleaf/shared";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

describe("isAttachmentPath", () => {
  it("accepts every non-markdown file outside hidden folders", () => {
    for (const path of ["image.png", "assets/사진.JPG", "docs/report.pdf", "a/b/c.docx", "data.json", "script.js", "noext", "a.md.png"]) {
      expect(isAttachmentPath(path), path).toBe(true);
    }
  });

  it("leaves markdown to the text sync, in any letter case", () => {
    for (const path of ["a.md", "notes/A.MD", "x.Md"]) expect(isAttachmentPath(path), path).toBe(false);
  });

  it("excludes hidden folders and files (.obsidian, .git, .trash, .leaflet, temp files)", () => {
    const excluded = [".obsidian/app.json", ".git/HEAD", ".trash/old.png", ".leaflet/workspace.json", ".Leaflet/cache.db", "a/.git/x", ".DS_Store", "photos/.DS_Store", "notes/.leaflet-123.tmp", ".gitignore"];
    for (const path of excluded) expect(isAttachmentPath(path), path).toBe(false);
  });

  it("excludes OS metadata files in any folder and letter case", () => {
    for (const path of ["Thumbs.db", "pics/thumbs.DB", "desktop.ini", "a/Desktop.ini"]) expect(isAttachmentPath(path), path).toBe(false);
    expect(isAttachmentPath("my-thumbs.db")).toBe(true);
  });

  it("rejects unsafe paths", () => {
    for (const path of ["", "../a.png", "/a.png", "C:/a.png", "a//b.png", "a\0.png", "a/./b.png"]) expect(isAttachmentPath(path), path).toBe(false);
  });
});

describe("attachment size limit", () => {
  it("allows exactly the limit and refuses one more byte or a negative size", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024);
    expect(isWithinAttachmentSizeLimit(0)).toBe(true);
    expect(isWithinAttachmentSizeLimit(MAX_ATTACHMENT_BYTES)).toBe(true);
    expect(isWithinAttachmentSizeLimit(MAX_ATTACHMENT_BYTES + 1)).toBe(false);
    expect(isWithinAttachmentSizeLimit(-1)).toBe(false);
    expect(isWithinAttachmentSizeLimit(1.5)).toBe(false);
  });
});

describe("sha256", () => {
  it("hashes bytes as lowercase hex", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("recognises only 64 lowercase hex characters", () => {
    expect(isSha256Hex(SHA)).toBe(true);
    for (const bad of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), `${"a".repeat(63)}/`]) expect(isSha256Hex(bad), bad).toBe(false);
  });
});

describe("parseAttachmentEntry", () => {
  const valid = { path: "img/a.png", deleted: false, createdAt: 1_700_000_000_000, blob: { sha256: SHA, size: 10, baseSha256: null } };

  it("reads a valid entry", () => {
    expect(parseAttachmentEntry(ID, valid)).toEqual({ attachmentId: ID, ...valid });
    const edited = { ...valid, blob: { sha256: OTHER_SHA, size: 0, baseSha256: SHA } };
    expect(parseAttachmentEntry(ID, edited)?.blob).toEqual(edited.blob);
  });

  it("drops entries another device could not use safely", () => {
    const bad: unknown[] = [
      null,
      "x",
      { ...valid, path: "../a.png" },
      { ...valid, path: "a.md" },
      { ...valid, path: ".obsidian/a.png" },
      { ...valid, deleted: "no" },
      { ...valid, createdAt: Number.NaN },
      { ...valid, createdAt: 9e15 },
      { ...valid, blob: null },
      { ...valid, blob: { ...valid.blob, sha256: "x" } },
      { ...valid, blob: { ...valid.blob, size: MAX_ATTACHMENT_BYTES + 1 } },
      { ...valid, blob: { ...valid.blob, size: -1 } },
      { ...valid, blob: { ...valid.blob, baseSha256: "x" } },
      { ...valid, blob: { sha256: SHA, size: 1 } },
    ];
    for (const raw of bad) expect(parseAttachmentEntry(ID, raw), JSON.stringify(raw)).toBeNull();
    expect(parseAttachmentEntry("not-a-uuid", valid)).toBeNull();
  });
});

describe("buildAttachmentConflictPath", () => {
  it("keeps the extension and uses the UTC date and the losing hash", () => {
    const timestampMs = Date.UTC(2026, 10, 23, 23, 30);
    expect(buildAttachmentConflictPath({ path: "img/photo.png", timestampMs, sha256: SHA })).toBe("img/photo (conflict 2026-11-23 aaaaaa).png");
    expect(buildAttachmentConflictPath({ path: "archive.tar.gz", timestampMs, sha256: SHA })).toBe("archive.tar (conflict 2026-11-23 aaaaaa).gz");
    expect(buildAttachmentConflictPath({ path: "dir.v2/noext", timestampMs, sha256: SHA })).toBe("dir.v2/noext (conflict 2026-11-23 aaaaaa)");
  });

  it("produces a path that is itself an attachment path", () => {
    const path = buildAttachmentConflictPath({ path: "a/b.pdf", timestampMs: 0, sha256: SHA });
    expect(isAttachmentPath(path)).toBe(true);
  });
});
