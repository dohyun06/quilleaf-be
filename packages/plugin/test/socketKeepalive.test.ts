import { afterEach, expect, it, vi } from "vitest";

// Before any import: lib0 (the provider's clock) keeps the Date.now it finds when it loads. Only intervals and the
// clock are faked; both idle checks run on them (provider: 30 s, server: 60 s, checked every 60 s).
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
});

import { DOCS_PER_SOCKET } from "../src/core/hocuspocusSyncer";
import { connectDocs, eventually, realDelay, startTestServer } from "./fakes/testServer";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("keeps idle sockets open past both idle timeouts (regression: sockets without presence reconnected every 30 s)", async () => {
  const server = await startTestServer(cleanups);
  const { statuses, handles } = connectDocs(server, DOCS_PER_SOCKET + 6, cleanups);
  await Promise.all(handles.map((handle) => handle.whenSynced()));
  await eventually(() => expect(statuses.at(-1)).toBe("connected"));
  const before = { statuses: statuses.length, accepted: server.accepted(), upgrades: server.upgrades() };

  for (let second = 0; second < 130; second++) {
    vi.advanceTimersByTime(1000);
    await realDelay(10); // lets the sockets carry a keepalive round trip
  }

  expect(statuses.slice(before.statuses)).toEqual([]);
  expect(server.upgrades()).toBe(before.upgrades);
  expect(server.accepted()).toBe(before.accepted);
  expect(server.openSockets()).toBe(2);
}, 30_000);
