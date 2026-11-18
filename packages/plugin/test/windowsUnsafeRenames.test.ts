import { afterEach, describe, expect, it } from "vitest";
import { buildIndexDocName, INDEX_FILES_MAP_KEY, MAX_SYNC_FILE_BYTES } from "@quilleaf/shared";
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

/** Stops the device, changes its disk the way Finder or git would while the plugin is off, then starts it again. */
async function restartAfter(hub: LoopbackHub, device: Device, change: (files: Map<string, string>) => void): Promise<Device> {
  await device.engine.stop();
  change(device.vault.files);
  const restarted = await startDevice(hub, device.name, { reuse: device });
  running.splice(running.indexOf(device), 1, restarted);
  return restarted;
}

function moveOnDisk(files: Map<string, string>, from: string, to: string, text = files.get(from) ?? ""): void {
  files.delete(from);
  files.set(to, text);
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

describe("renames to names Windows cannot hold reported as delete + create (regression: synced deletion)", () => {
  const oversize = "x".repeat(MAX_SYNC_FILE_BYTES + 1);
  it.each([
    ["an empty note", "", "", ""],
    ["a note edited in the same save", "body", "edited body", "edited body"],
    ["a note grown past the size limit", "body", oversize, "body"],
  ])("pairs %s", async (_case, before, after, onB) => {
    const { hub, a, b } = await syncedPair({ "a.md": before });
    a.vault.externalDelete("a.md");
    a.vault.externalWrite("a?.md", after);
    await settle([a, b]);
    expect(filesOf(b)).toEqual({ "a.md": onB });
    expect(serverPaths(hub)).toEqual(["a.md"]);
    expect(unsafeNotices(a)).toEqual([{ kind: "windows-unsafe-name", path: "a?.md", keptPath: "a.md" }]);
    nothingTrashed([a, b]);
  });

  it("pairs each note of a folder renamed this way by file name", async () => {
    const { hub, a, b } = await syncedPair({ "Misc/x.md": "x", "Misc/y.md": "y" });
    for (const name of ["x", "y"]) a.vault.externalDelete(`Misc/${name}.md`);
    for (const name of ["y", "x"]) a.vault.externalWrite(`Misc./${name}.md`, `${name} edited`);
    await settle([a, b]);
    expect(filesOf(b)).toEqual({ "Misc/x.md": "x edited", "Misc/y.md": "y edited" });
    expect(serverPaths(hub)).toEqual(["Misc/x.md", "Misc/y.md"]);
    nothingTrashed([a, b]);
  });
});

describe("renames made while the plugin was stopped", () => {
  it.each(["a?.md", "a.md "])("holds a note renamed and edited to %j", async (unsafe) => {
    const { hub, a, b } = await syncedPair({ "a.md": "body" });
    const restarted = await restartAfter(hub, a, (files) => moveOnDisk(files, "a.md", unsafe, "edited"));
    await settle([restarted, b]);
    expect(filesOf(b)).toEqual({ "a.md": "edited" });
    expect(serverPaths(hub)).toEqual(["a.md"]);
    nothingTrashed([restarted, b]);
  });

  it.each(["fine.md", "a.md"])("moves a held note renamed and edited to %j, with no ghost or late delete", async (safe) => {
    const { hub, a, b } = await syncedPair({ "a.md": "body" });
    a.vault.externalRename("a.md", "a.md ");
    await settle([a, b]);
    const first = await restartAfter(hub, a, (files) => moveOnDisk(files, "a.md ", safe, "edited"));
    await settle([first, b]);
    expect(filesOf(b)).toEqual({ [safe]: "edited" });
    expect(serverPaths(hub)).toEqual([safe]);

    const second = await restartAfter(hub, first, () => {});
    await settle([second, b]);
    expect(filesOf(b)).toEqual({ [safe]: "edited" });
    expect(filesOf(second)).toEqual({ [safe]: "edited" });
    nothingTrashed([second, b]);
  });

  it("deletes a held note deleted while stopped on the first start, not one start later", async () => {
    const { hub, a, b } = await syncedPair({ "a.md": "body" });
    a.vault.externalRename("a.md", "a.md ");
    await settle([a, b]);
    const restarted = await restartAfter(hub, a, (files) => files.delete("a.md "));
    await settle([restarted, b]);
    expect(filesOf(b)).toEqual({});
    expect(serverPaths(hub)).toEqual(["a.md (deleted)"]);
  });
});
