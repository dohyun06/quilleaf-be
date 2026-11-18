import { afterEach, describe, expect, it } from "vitest";
import { buildFileDocName, isWindowsSafePath } from "@obsidian-crdt/shared";
import { UnwritablePathError } from "../src/obsidian/vaultAdapter";
import { createDevice, type Device, settle, startDevice, TEST_VAULT_ID } from "./fakes/device";
import { LoopbackHub } from "./fakes/loopback";
import { orderedFileId, RawIndexClient } from "./fakes/rawIndex";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

/** A Windows device: like ObsidianVaultAdapter with `windows: true`, its vault refuses names Windows cannot hold. */
async function startWindows(hub: LoopbackHub): Promise<Device> {
  const device = createDevice(hub, "W");
  const { vault } = device;
  const replace = vault.replace.bind(vault);
  const rename = vault.rename.bind(vault);
  vault.replace = async (path, expected, next) => {
    if (expected === null && !isWindowsSafePath(path)) throw new UnwritablePathError(path);
    return replace(path, expected, next);
  };
  vault.rename = async (oldPath, newPath) => {
    if (!isWindowsSafePath(newPath)) throw new UnwritablePathError(newPath);
    return rename(oldPath, newPath);
  };
  running.push(device);
  await device.engine.start();
  return device;
}

async function start(hub: LoopbackHub, name: string, files: Record<string, string> = {}): Promise<Device> {
  const device = await startDevice(hub, name, { files });
  running.push(device);
  return device;
}

const ID = orderedFileId(1);
const serverText = (hub: LoopbackHub) => hub.serverText(buildFileDocName(TEST_VAULT_ID, ID));

describe("paths another client syncs but Windows cannot hold (mixed rollout)", () => {
  it("keeps the note live at its old name when another client renames it, and trashes it on a later remote delete", async () => {
    const hub = new LoopbackHub();
    const other = new RawIndexClient(hub);
    other.create(ID, "safe.md", "body");
    const w = await startWindows(hub);
    await settle([w]);

    other.rename(ID, "notes./safe.md");
    await settle([w]);
    expect(Object.fromEntries(w.vault.files)).toEqual({ "safe.md": "body" });
    expect(w.storage.records.get(ID)?.path).toBe("safe.md");
    w.vault.externalWrite("safe.md", "edited on Windows");
    await settle([w]);
    expect(serverText(hub)).toBe("edited on Windows");
    expect(other.entry(ID)).toEqual({ path: "notes./safe.md", deleted: false });

    other.delete(ID);
    await settle([w]);
    expect(w.vault.files.size).toBe(0);
    expect(w.vault.trashed).toEqual([{ path: "safe.md", text: "edited on Windows" }]);
    expect(w.storage.records.has(ID)).toBe(false);
  });

  it("treats the old-name copy as the note itself: deleting it there deletes the renamed note", async () => {
    const hub = new LoopbackHub();
    const other = new RawIndexClient(hub);
    other.create(ID, "safe.md", "body");
    const w = await startWindows(hub);
    await settle([w]);
    other.rename(ID, "notes./safe.md");
    await settle([w]);

    w.vault.externalDelete("safe.md");
    await settle([w]);
    expect(other.entry(ID)).toEqual({ path: "notes./safe.md", deleted: true });
  });

  it("moves a note within a trailing-dot folder between devices that can hold it, and deletes nothing on Windows", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "Misc./a.md": "dotted folder" });
    const b = await start(hub, "B");
    const w = await startWindows(hub);
    await settle([a, b, w]);
    expect(b.vault.files.get("Misc./a.md")).toBe("dotted folder");
    expect(w.vault.files.size).toBe(0);

    b.vault.externalRename("Misc./a.md", "Misc./b.md");
    await settle([a, b, w]);
    expect(Object.fromEntries(a.vault.files)).toEqual({ "Misc./b.md": "dotted folder" });
    for (const device of [a, b, w]) expect(device.vault.trashed).toEqual([]);
    expect(w.notices.filter((notice) => notice.kind === "task-failed").length).toBeGreaterThan(0);
  });
});
