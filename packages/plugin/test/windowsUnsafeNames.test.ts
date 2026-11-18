import { afterEach, describe, expect, it } from "vitest";
import { buildIndexDocName, INDEX_FILES_MAP_KEY } from "@quilleaf/shared";
import type * as Y from "yjs";
import { type Device, restartDevice, settle, startDevice, TEST_VAULT_ID } from "./fakes/device";
import { LoopbackHub } from "./fakes/loopback";
import { orderedFileId, RawIndexClient } from "./fakes/rawIndex";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

/** A device whose file system holds any name, like macOS, Linux or Android. */
async function start(hub: LoopbackHub, name: string, files: Record<string, string> = {}): Promise<Device> {
  const device = await startDevice(hub, name, { files });
  running.push(device);
  return device;
}

/** Path of every index entry on the server, deleted ones marked with a trailing "(deleted)". */
function serverPaths(hub: LoopbackHub): string[] {
  const files = hub.serverDoc(buildIndexDocName(TEST_VAULT_ID)).getMap<Y.Map<unknown>>(INDEX_FILES_MAP_KEY);
  return [...files.values()].map((entry) => `${entry.get("path")}${entry.get("deleted") ? " (deleted)" : ""}`).sort();
}

const unsafeNotices = (device: Device) => device.notices.filter((notice) => notice.kind === "windows-unsafe-name");
const nothingTrashed = (devices: Device[]) => devices.forEach((device) => expect(device.vault.trashed, device.name).toEqual([]));

describe("names Windows cannot hold, created or renamed locally", () => {
  it("keeps a new note with such a name off the server and tells the user once", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "ok.md": "fine" });
    const b = await start(hub, "B");
    await settle([a, b]);

    a.vault.externalWrite("what?.md", "question");
    a.vault.externalWrite("CON.md", "device name");
    await settle([a, b]);
    a.vault.externalWrite("what?.md", "question, edited");
    await settle([a, b]);

    expect(serverPaths(hub)).toEqual(["ok.md"]);
    expect(Object.fromEntries(b.vault.files)).toEqual({ "ok.md": "fine" });
    expect(unsafeNotices(a).map((notice) => notice.path).sort()).toEqual(["CON.md", "what?.md"]);

    a.vault.externalRename("what?.md", "what.md");
    await settle([a, b]);
    expect(b.vault.files.get("what.md")).toBe("question, edited");
    expect(serverPaths(hub)).toEqual(["ok.md", "what.md"]);
  });

  it("keeps a synced note at its old name elsewhere when renamed to such a name, and syncs the next safe rename", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "body" });
    const b = await start(hub, "B");
    await settle([a, b]);

    a.vault.externalRename("a.md", "a?.md");
    await settle([a, b]);
    expect(Object.fromEntries(b.vault.files)).toEqual({ "a.md": "body" });
    expect(Object.fromEntries(a.vault.files)).toEqual({ "a?.md": "body" });
    expect(serverPaths(hub)).toEqual(["a.md"]);
    expect(unsafeNotices(a)).toEqual([{ kind: "windows-unsafe-name", path: "a?.md", keptPath: "a.md" }]);

    a.vault.externalWrite("a?.md", "edited under the unsafe name");
    await settle([a, b]);
    expect(b.vault.files.get("a.md")).toBe("edited under the unsafe name");
    b.vault.externalWrite("a.md", "edited on B");
    await settle([a, b]);
    expect(a.vault.files.get("a?.md")).toBe("edited on B");

    const restarted = await restartDevice(hub, a);
    running.splice(running.indexOf(a), 1, restarted);
    await settle([restarted, b]);
    expect(Object.fromEntries(restarted.vault.files)).toEqual({ "a?.md": "edited on B" });

    restarted.vault.externalRename("a?.md", "b.md");
    await settle([restarted, b]);
    expect(Object.fromEntries(b.vault.files)).toEqual({ "b.md": "edited on B" });
    expect(serverPaths(hub)).toEqual(["b.md"]);
    nothingTrashed([restarted, b]);
  });

  it("applies another device's rename to a note held under such a name", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "a.md": "body" });
    const b = await start(hub, "B");
    await settle([a, b]);
    a.vault.externalRename("a.md", "a?.md");
    await settle([a, b]);

    b.vault.externalRename("a.md", "c.md");
    await settle([a, b]);
    expect(Object.fromEntries(a.vault.files)).toEqual({ "c.md": "body" });
    expect(serverPaths(hub)).toEqual(["c.md"]);
    nothingTrashed([a, b]);
  });

  it("keeps the notes of a folder renamed to such a name at their old paths elsewhere", async () => {
    const hub = new LoopbackHub();
    const a = await start(hub, "A", { "Misc/x.md": "x", "Misc/y.md": "y" });
    const b = await start(hub, "B");
    await settle([a, b]);

    a.vault.externalRename("Misc/x.md", "Misc./x.md");
    a.vault.externalRename("Misc/y.md", "Misc./y.md");
    await settle([a, b]);
    expect(Object.fromEntries(b.vault.files)).toEqual({ "Misc/x.md": "x", "Misc/y.md": "y" });
    expect(serverPaths(hub)).toEqual(["Misc/x.md", "Misc/y.md"]);
    nothingTrashed([a, b]);

    a.vault.externalWrite("Misc./y.md", "y edited");
    await settle([a, b]);
    expect(b.vault.files.get("Misc/y.md")).toBe("y edited");
  });

  it("still moves a legacy entry whose name Windows cannot hold when another client renames it", async () => {
    const hub = new LoopbackHub();
    const other = new RawIndexClient(hub);
    other.create(orderedFileId(1), "ab:c.md", "legacy");
    const a = await start(hub, "A");
    await settle([a]);
    expect(a.vault.files.get("ab:c.md")).toBe("legacy");

    other.rename(orderedFileId(1), "abc.md");
    await settle([a]);
    expect(Object.fromEntries(a.vault.files)).toEqual({ "abc.md": "legacy" });
    nothingTrashed([a]);
  });
});
