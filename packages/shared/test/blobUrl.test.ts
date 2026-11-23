import { describe, expect, it } from "vitest";
import { buildBlobUrl, parseBlobRoute } from "@quilleaf/shared";

const SHA = "0123456789abcdef".repeat(4);

describe("buildBlobUrl", () => {
  it("turns the WebSocket server URL into the blob URL under the same path", () => {
    expect(buildBlobUrl("wss://example.dev/sync", "my-vault-01", SHA)).toBe(`https://example.dev/sync/blobs/my-vault-01/${SHA}`);
    expect(buildBlobUrl("wss://example.dev/sync/", "my-vault-01", SHA)).toBe(`https://example.dev/sync/blobs/my-vault-01/${SHA}`);
    expect(buildBlobUrl("ws://localhost:1234", "my-vault-01", SHA)).toBe(`http://localhost:1234/blobs/my-vault-01/${SHA}`);
    expect(buildBlobUrl("wss://example.dev/sync?x=1#y", "my-vault-01", SHA)).toBe(`https://example.dev/sync/blobs/my-vault-01/${SHA}`);
  });

  it("refuses a non-WebSocket URL, a bad vault id or a bad hash", () => {
    expect(() => buildBlobUrl("https://example.dev", "my-vault-01", SHA)).toThrow();
    expect(() => buildBlobUrl("wss://example.dev", "Bad", SHA)).toThrow();
    expect(() => buildBlobUrl("wss://example.dev", "my-vault-01", "x")).toThrow();
  });
});

describe("parseBlobRoute", () => {
  it("reads the route with or without the proxy prefix", () => {
    expect(parseBlobRoute(`/blobs/my-vault-01/${SHA}`)).toEqual({ vaultId: "my-vault-01", sha256: SHA });
    expect(parseBlobRoute(`/sync/blobs/my-vault-01/${SHA}`)).toEqual({ vaultId: "my-vault-01", sha256: SHA });
  });

  it("round-trips buildBlobUrl", () => {
    const url = new URL(buildBlobUrl("wss://example.dev/sync", "my-vault-01", SHA));
    expect(parseBlobRoute(url.pathname)).toEqual({ vaultId: "my-vault-01", sha256: SHA });
  });

  it("returns null for anything else", () => {
    const bad = [
      "/",
      "/blobs",
      `/blobs/my-vault-01/${SHA}/x`,
      `/blobs/MY-VAULT-01/${SHA}`,
      `/blobs/my-vault-01/${SHA.toUpperCase()}`,
      `/blobs/../${SHA}`,
      `/blobs/my-vault-01/..%2F${SHA.slice(5)}`,
      `/xblobs/my-vault-01/${SHA}`,
      `/blobs/my-vault-01/${SHA}?x`,
    ];
    for (const path of bad) expect(parseBlobRoute(path), path).toBeNull();
  });
});
