import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { buildFileDocName } from "@quilleaf/shared";
import { createJsonLogger, createSyncServer, DocumentStore, openDatabase, TokenStore } from "@quilleaf/server";
import { HocuspocusSyncer } from "../../src/core/hocuspocusSyncer";
import { TEST_VAULT_ID } from "./device";

type Cleanup = () => Promise<void> | void;

export const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The real server with an in-memory database and a test token; counts WebSocket upgrades and open sockets. */
export async function startTestServer(cleanups: Cleanup[]) {
  const db = openDatabase(":memory:");
  const tokens = new TokenStore(db);
  const logs: string[] = [];
  const server = createSyncServer({
    port: 0,
    address: "127.0.0.1",
    documents: new DocumentStore(db),
    tokens,
    logger: createJsonLogger((line) => logs.push(line)),
    storeDebounceMs: 0,
  });
  const open = new Set<Socket>();
  let upgrades = 0;
  server.httpServer.on("upgrade", (_request, socket: Socket) => {
    upgrades++;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await server.listen();
  cleanups.push(() => server.destroy());
  return {
    url: `ws://127.0.0.1:${server.address.port}`,
    token: tokens.issue(TEST_VAULT_ID).token,
    accepted: () => logs.filter((line) => line.includes("auth.accepted")).length,
    upgrades: () => upgrades,
    openSockets: () => open.size,
  };
}

/** A syncer with `count` new documents attached; every status it reports is recorded. */
export function connectDocs(server: { url: string; token: string }, count: number, cleanups: Cleanup[]) {
  const statuses: string[] = [];
  const syncer = new HocuspocusSyncer({ url: server.url, token: server.token, onAuthFailed: () => {}, onStatus: (status) => statuses.push(status) });
  cleanups.push(() => syncer.destroy());
  const handles = Array.from({ length: count }, () => syncer.connect(buildFileDocName(TEST_VAULT_ID, randomUUID()), new Y.Doc()));
  return { syncer, statuses, handles };
}

export async function eventually(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  for (let waited = 0; ; waited += 25) {
    try {
      return assertion();
    } catch (error) {
      if (waited > timeoutMs) throw error;
      await realDelay(25);
    }
  }
}
