import { afterEach, describe, expect, it } from "vitest";
import { DOCS_PER_SOCKET } from "../src/core/hocuspocusSyncer";
import { connectDocs, eventually, startTestServer } from "./fakes/testServer";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("HocuspocusSyncer sockets", () => {
  it("adds a socket without reporting connecting again, and closes it once its last document is gone", async () => {
    const server = await startTestServer(cleanups);
    const { statuses, handles } = connectDocs(server, DOCS_PER_SOCKET + 2, cleanups);
    await Promise.all(handles.map((handle) => handle.whenSynced()));
    await eventually(() => expect(server.openSockets()).toBe(2));
    await eventually(() => expect(statuses.at(-1)).toBe("connected"));
    expect(statuses).toEqual(["connecting", "connected"]);

    for (const handle of handles.slice(DOCS_PER_SOCKET)) handle.destroy();
    await eventually(() => expect(server.openSockets()).toBe(1));
    expect(statuses).toEqual(["connecting", "connected"]);
  });
});
