import { describe, expect, it } from "vitest";
import {
  foldPathCase,
  isSafeRelativePath,
  isSyncablePath,
  isWindowsSafePath,
  isWithinSizeLimit,
  MAX_SYNC_FILE_BYTES,
  normalizeVaultPath,
  utf8ByteLength,
} from "@quilleaf/shared";

describe("vault paths", () => {
  it("unifies separators and strips leading ./ and /", () => {
    expect(normalizeVaultPath("./notes\\a.md")).toBe("notes/a.md");
    expect(normalizeVaultPath("/a.md")).toBe("a.md");
  });

  it("does not change Unicode normalization", () => {
    const nfd = "한글.md".normalize("NFD");
    expect(normalizeVaultPath(nfd)).toBe(nfd);
  });

  it("rejects unsafe paths", () => {
    for (const bad of ["", "../a.md", "a/../b.md", "/abs.md", "C:/x.md", "a//b.md", "a\0.md", "./a.md"]) {
      expect(isSafeRelativePath(bad)).toBe(false);
    }
    expect(isSafeRelativePath("notes/a.md")).toBe(true);
  });

  it("keeps reading names other clients sync, even ones Windows cannot hold (regression: delete and ghost paths)", () => {
    for (const path of ["Misc./a.md", "notes /a.md", "ab:c.md", "a.md.", "a\\b.md"]) expect(isSafeRelativePath(path), path).toBe(true);
  });

  it("flags names Windows cannot hold or resolves elsewhere: backslash, colon, trailing dot or space", () => {
    const bad = [
      "a\\b.md",
      "..\\..\\outside.md",
      "a:b.md",
      "a.md:stream",
      "notes:/a.md",
      "a.md.",
      "a.md ",
      "notes./a.md",
      "notes /a.md",
      ".. /a.md",
      "...",
      "a/b.md\t ",
    ];
    for (const path of bad) expect(isWindowsSafePath(path), path).toBe(false);
  });

  it("flags Windows reserved characters, control characters and device names in any segment", () => {
    const bad = ["what?.md", "a<b.md", "a>b.md", 'say "hi".md', "a|b.md", "a*.md", "a\u0001b.md", "tab\there.md", "CON.md", "con", "notes/Aux.md", "NUL.tar.md", "COM1.md", "lpt9/a.md", "prn.MD", "COM¹.md", "LPT³", "CONIN$.md", "conout$", "CON .md"];
    for (const path of bad) expect(isWindowsSafePath(path), path).toBe(false);
  });

  it("accepts names that only contain a device name", () => {
    const good = ["CONsole.md", "my con.md", "COM0.md", "COM10.md", "lpt.md", "notes/nullable.md", "a-con.md"];
    for (const path of good) expect(isWindowsSafePath(path), path).toBe(true);
  });

  it("accepts names that only look close to the Windows rules", () => {
    const good = [".hidden.md", " leading space.md", "a b.md", "a.b.md", "notes.d/a.md", "a. .md", "한글.md", "x/.config/y.md"];
    for (const path of good) expect(isWindowsSafePath(path), path).toBe(true);
  });

  it("syncs markdown outside excluded folders only", () => {
    expect(isSyncablePath("notes/a.md")).toBe(true);
    expect(isSyncablePath("notes/A.MD")).toBe(true);
    expect(isSyncablePath("image.png")).toBe(false);
    expect(isSyncablePath(".obsidian/workspace.md")).toBe(false);
    expect(isSyncablePath(".trash/old.md")).toBe(false);
    expect(isSyncablePath(".git/x.md")).toBe(false);
    expect(isSyncablePath("custom-config/x.md", ["custom-config/"])).toBe(false);
  });

  it("measures size in UTF-8 bytes", () => {
    expect(utf8ByteLength("가")).toBe(3);
    expect(isWithinSizeLimit("a".repeat(MAX_SYNC_FILE_BYTES))).toBe(true);
    expect(isWithinSizeLimit("a".repeat(MAX_SYNC_FILE_BYTES + 1))).toBe(false);
  });

  it("excludes configured folders regardless of letter case", () => {
    expect(isSyncablePath(".Obsidian/workspace.md")).toBe(false);
    expect(isSyncablePath(".TRASH/a.md")).toBe(false);
    expect(isSyncablePath("Custom-Config/x.md", ["custom-config/"])).toBe(false);
  });

  it("folds path case for collision checks", () => {
    expect(foldPathCase("Notes/Note.md")).toBe(foldPathCase("notes/note.md"));
  });

  it("folds Unicode normalization forms for collision checks", () => {
    expect(foldPathCase("한글.md".normalize("NFD"))).toBe(foldPathCase("한글.md".normalize("NFC")));
  });
});
