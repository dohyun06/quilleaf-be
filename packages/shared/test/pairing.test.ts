import { describe, expect, it } from "vitest";
import { buildPairUrl, formatPairCode, normalizePairCode, parsePairRoute } from "../src/pairing";

describe("normalizePairCode", () => {
  it("ignores case, hyphens and spaces", () => {
    expect(normalizePairCode("k7qm-2xpa")).toBe("K7QM2XPA");
    expect(normalizePairCode(" K7QM 2XPA ")).toBe("K7QM2XPA");
  });

  it("reads O as 0 and I/L as 1", () => {
    expect(normalizePairCode("OILOILOI")).toBe("01101101");
    expect(normalizePairCode("oilk7qm2")).toBe("011K7QM2");
  });

  it("rejects wrong lengths and characters outside the alphabet", () => {
    for (const bad of ["", "K7QM2XP", "K7QM2XPAA", "K7QM2XPU", "K7QM2XP!"]) expect(normalizePairCode(bad)).toBeNull();
  });

  it("formats with a hyphen", () => {
    expect(formatPairCode("K7QM2XPA")).toBe("K7QM-2XPA");
  });
});

describe("pair URLs", () => {
  it("builds the three endpoints under the server path", () => {
    expect(buildPairUrl("wss://host/sync", "request")).toBe("https://host/sync/pair");
    expect(buildPairUrl("ws://host:1/sync/", "approve")).toBe("http://host:1/sync/pair/approve");
    expect(buildPairUrl("wss://host", "claim")).toBe("https://host/pair/claim");
  });

  it("rejects a non-WebSocket URL", () => {
    expect(() => buildPairUrl("https://host/sync", "request")).toThrow();
  });

  it("parses the route with or without a prefix", () => {
    expect(parsePairRoute("/sync/pair")).toBe("request");
    expect(parsePairRoute("/pair/approve")).toBe("approve");
    expect(parsePairRoute("/sync/pair/claim")).toBe("claim");
    expect(parsePairRoute("/pair/other")).toBeNull();
    expect(parsePairRoute("/repair")).toBeNull();
  });
});