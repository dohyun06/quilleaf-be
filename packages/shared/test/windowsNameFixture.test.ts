import { describe, expect, it } from "vitest";
import { isWindowsSafePath } from "@quilleaf/shared";

/** The one Windows-unsafe name rule, shared verbatim with the quilleaf app (Rust and TypeScript). */
const UNSAFE = [
  "a?.md", "a:b.md", "C:/a.md", "a.md ", "a.md.", "Misc./a.md", "Misc /a.md", "a\u0001.md", "CON.md", "con.txt.md",
  "CON .md", "CON..md", "Nul/a.md", "CONIN$.md", "conout$.md", "COM0.md", "COM¹.md", "lpt³.md", "a<b.md", "a|b.md",
  "a*b.md", 'a"b.md', "a\b.md",
];
const SAFE = [
  "a.md", "a\u007f.md", "a\u0085.md", "folder\u009f/a.md", "CON\u00a0.md", "CONX.md", "COM10.md", "COM⁴.md", "console.md",
  ".hidden-not-relevant/a.md", "한글 노트.md", "a b.md",
];

describe("the shared Windows name fixture", () => {
  it.each(UNSAFE)("flags %j", (path) => expect(isWindowsSafePath(path)).toBe(false));
  it.each(SAFE)("accepts %j", (path) => expect(isWindowsSafePath(path)).toBe(true));
});
