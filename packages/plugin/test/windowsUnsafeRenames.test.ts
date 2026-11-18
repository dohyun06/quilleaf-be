import { afterEach, describe, expect, it } from "vitest";
import { buildIndexDocName, INDEX_FILES_MAP_KEY } from "@quilleaf/shared";
import type * as Y from "yjs";
import { type Device, settle, startDevice, TEST_VAULT_ID } from "./fakes/device";
import { LoopbackHub } from "./fakes/loopback";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

async function start(hub: LoopbackHub, name: string, files: Record<string, string> = {}): Promise<Device> {
  const device = await startDevice(hub, name, { files });
  running.push(device);
  return device;
}

function serverPaths(hub: LoopbackHub): string[] {
  const files = hub.serverDoc(buildIndexDocName(TEST_VAULT_ID)).getMap<Y.Map<unknown>>(INDEX_FILES_MAP_KEY);
  return [...files.values()].map((entry) => `${entry.get("path")}${entry.get("deleted") ? " (deleted)" : ""}`).sort();
}

const filesOf = (device: Device) => Object.fromEntries(device.vault.files);
const unsafeNotices = (device: Device) => device.notices.filter((notice) => notice.kind === "windows-unsafe-name");
const nothingTrashed = (devices: Device[]) => devices.forEach((device) => expect(device.vault.trashed, device.name).toEqual([]));

async function syncedPair(files: Record<string, string>): Promise<{ hub: LoopbackHub; a: Device; b: Device }> {
  const hub = new LoopbackHub();
  const a = await start(hub, "A", files);
  const b = await start(hub, "B");
  await settle([a, b]);
  return { hub, a, b };
}

describe("renames to names Windows cannot hold that also fail the .md or drive check (regression: synced deletion)", () => {
  it.each(["a.md ", "a.md."])("holds a note renamed to %j", async (unsafe) => {
    const { hub, a, b } = await syncedPair({ "a.md": "body" });
    a.vault.externalRename("a.md", unsafe);
    await settle([a, b]);
    expect(filesOf(b)).toEqual({ "a.md": "body" });
    expect(serverPaths(hub)).toEqual(["a.md"]);
    expect(unsafeNotices(a)).toEqual([{ kind: "windows-unsafe-name", path: unsafe, keptPath: "a.md" }]);

    a.vault.externalWrite(unsafe, "edited");
    await settle([a, b]);
    expect(filesOf(b)).toEqual({ "a.md": "edited" });
    nothingTrashed([a, b]);
  });

  it("holds the notes of a folder renamed so a child gets a drive prefix", async () => {
    const { hub, a, b } = await syncedPair({ "folder/a.md": "body" });
    a.vault.externalRename("folder/a.md", "C:/a.md");
    await settle([a, b]);
    expect(filesOf(b)).toEqual({ "folder/a.md": "body" });
    expect(serverPaths(hub)).toEqual(["folder/a.md"]);
    nothingTrashed([a, b]);
  });

  it("keeps holding a held note renamed again to a name that fails the .md check", async () => {
    const { hub, a, b } = await syncedPair({ "a.md": "body" });
    a.vault.externalRename("a.md", "a?.md");
    await settle([a, b]);
    a.vault.externalRename("a?.md", "b.md ");
    await settle([a, b]);
    expect(filesOf(b)).toEqual({ "a.md": "body" });
    expect(serverPaths(hub)).toEqual(["a.md"]);
    nothingTrashed([a, b]);

    a.vault.externalRename("b.md ", "b.md");
    await settle([a, b]);
    expect(filesOf(b)).toEqual({ "b.md": "body" });
    expect(serverPaths(hub)).toEqual(["b.md"]);
  });

  it.each([".obsidian/a?.md", "a.txt "])("still deletes a note moved to %j, which is excluded for another reason", async (excluded) => {
    const { hub, a, b } = await syncedPair({ "a.md": "body" });
    a.vault.externalRename("a.md", excluded);
    await settle([a, b]);
    expect(filesOf(b)).toEqual({});
    expect(serverPaths(hub)).toEqual(["a.md (deleted)"]);
  });
});
