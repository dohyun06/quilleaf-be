import { afterEach, describe, expect, it } from "vitest";
import { createDevice, type Device, settle } from "./fakes/device";
import { LoopbackHub } from "./fakes/loopback";
import { orderedFileId, RawIndexClient } from "./fakes/rawIndex";

const running: Device[] = [];
afterEach(async () => {
  for (const device of running.splice(0)) await device.engine.stop();
});

/** A device whose file system rejects some names on create and move, like Windows with "?". */
async function startRejecting(hub: LoopbackHub, rejects: (path: string) => boolean): Promise<Device> {
  const device = createDevice(hub, "W");
  const { vault } = device;
  const replace = vault.replace.bind(vault);
  const rename = vault.rename.bind(vault);
  vault.replace = async (path, expected, next) => {
    if (rejects(path)) throw new Error(`invalid file name: ${path}`);
    return replace(path, expected, next);
  };
  vault.rename = async (oldPath, newPath) => {
    if (rejects(newPath)) throw new Error(`invalid file name: ${newPath}`);
    return rename(oldPath, newPath);
  };
  running.push(device);
  await device.engine.start();
  return device;
}

const failures = (device: Device) => device.notices.filter((notice) => notice.kind === "task-failed");

describe("an index entry this device cannot write", () => {
  it("does not block the entries after it, on the first pass or later ones (regression: one bad name stopped every later creation)", async () => {
    const hub = new LoopbackHub();
    const other = new RawIndexClient(hub);
    other.create(orderedFileId(1), "what?.md", "from a Mac");
    for (const n of [2, 3, 4]) other.create(orderedFileId(n), `n${n}.md`, `note ${n}`);
    const w = await startRejecting(hub, (path) => path.includes("?"));
    await settle([w]);
    expect(Object.fromEntries(w.vault.files)).toEqual({ "n2.md": "note 2", "n3.md": "note 3", "n4.md": "note 4" });

    other.create(orderedFileId(5), "later.md", "created later");
    await settle([w]);
    expect(w.vault.files.get("later.md")).toBe("created later");
    expect(failures(w)).toHaveLength(1); // reported once per entry, not once per pass
    expect(failures(w)[0]).toMatchObject({ message: expect.stringContaining("what?.md") });
    expect(other.entry(orderedFileId(1))).toEqual({ path: "what?.md", deleted: false });
  });

  it("does not block other moves and creations when its move fails", async () => {
    const hub = new LoopbackHub();
    const other = new RawIndexClient(hub);
    other.create(orderedFileId(1), "a.md", "a");
    other.create(orderedFileId(2), "b.md", "b");
    const w = await startRejecting(hub, (path) => path.includes("?"));
    await settle([w]);

    other.rename(orderedFileId(1), "a?.md");
    other.rename(orderedFileId(2), "moved.md");
    other.create(orderedFileId(3), "c.md", "c");
    await settle([w]);
    expect(Object.fromEntries(w.vault.files)).toEqual({ "a.md": "a", "moved.md": "b", "c.md": "c" });
    expect(failures(w)).toHaveLength(1);
  });
});
