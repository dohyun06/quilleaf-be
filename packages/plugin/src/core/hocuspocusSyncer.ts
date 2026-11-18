import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { RECONNECT_MAX_DELAY_MS } from "@obsidian-crdt/shared";
import type * as Y from "yjs";
import type { DocSyncer, DocSyncHandle } from "./ports";
import { assertSecureServerUrl } from "./serverUrl";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface HocuspocusSyncerOptions {
  url: string;
  token: string;
  onAuthFailed: () => void;
  onStatus?: (status: ConnectionStatus) => void;
}

/**
 * Documents per WebSocket. Every (re)connect sends one auth request per attached document at once, and the server
 * closes a socket with `maxPendingDocuments` (default 100) of them unanswered; staying under it holds on every reconnect.
 */
export const DOCS_PER_SOCKET = 64;

/**
 * The provider closes a socket that received nothing for 30 s (`messageReconnectTimeout`), the server one that sent
 * nothing for 60 s. Awareness renewals keep only sockets with a bound editor busy, so every socket sends this often.
 */
export const SOCKET_KEEPALIVE_MS = 15_000;

interface Shard {
  socket: HocuspocusProviderWebsocket;
  docs: number;
  providers: Set<HocuspocusProvider>;
  status: ConnectionStatus;
  keepalive: ReturnType<typeof setInterval>;
}

/** Documents share WebSockets (multiplexing), at most DOCS_PER_SOCKET each. */
export class HocuspocusSyncer implements DocSyncer {
  private readonly shards: Shard[] = [];
  private readonly providers = new Set<HocuspocusProvider>();
  private authFailed = false;
  private paused = false;
  private reported: ConnectionStatus | null = null;

  constructor(private readonly options: HocuspocusSyncerOptions) {
    assertSecureServerUrl(options.url);
  }

  connect(docName: string, doc: Y.Doc): DocSyncHandle {
    const shard = this.shards.find((s) => s.docs < DOCS_PER_SOCKET) ?? this.addShard();
    shard.docs++;
    const provider = new HocuspocusProvider({
      websocketProvider: shard.socket,
      name: docName,
      document: doc,
      token: this.options.token,
      onAuthenticationFailed: () => this.handleAuthFailed(),
    });
    // No presence until an editor binds this doc: a non-null local state is renewed every 15 s for every
    // subscribed doc (thousands of notes → constant awareness traffic). attachSync publishes it on bind.
    provider.awareness?.setLocalState(null);
    provider.attach();
    this.providers.add(provider);
    shard.providers.add(provider);
    return {
      awareness: provider.awareness ?? null,
      isSynced: () => provider.isSynced,
      whenSynced: () => waitForSynced(provider),
      destroy: () => {
        if (!this.providers.delete(provider)) return;
        provider.destroy();
        shard.providers.delete(provider);
        shard.docs--;
      },
    };
  }

  /** Disconnects without forgetting documents; edits keep accumulating locally. */
  pause(): void {
    this.paused = true;
    for (const { socket } of this.shards) socket.disconnect();
  }

  resume(): void {
    this.paused = false;
    if (this.authFailed) return;
    // disconnect() closes asynchronously. If resume() lands before the close event, connect() returns early
    // (still "connected") without re-arming, and the close would then leave the socket down for good.
    for (const { socket } of this.shards) {
      socket.shouldConnect = true;
      void socket.connect();
    }
  }

  destroy(): void {
    for (const provider of this.providers) provider.destroy();
    this.providers.clear();
    for (const { socket, keepalive } of this.shards) {
      clearInterval(keepalive);
      socket.destroy();
    }
    this.shards.length = 0;
  }

  private addShard(): Shard {
    // made before its socket, which may report a status while it is constructed
    const shard = { docs: 0, providers: new Set(), status: "connecting" } as unknown as Shard;
    shard.socket = new HocuspocusProviderWebsocket({
      url: this.options.url,
      maxDelay: RECONNECT_MAX_DELAY_MS,
      // a socket added while paused or after an auth failure stays down like the others
      autoConnect: !this.paused && !this.authFailed,
      onStatus: ({ status }) => {
        shard.status = status as ConnectionStatus;
        this.reportStatus();
      },
    });
    shard.keepalive = setInterval(() => keepAlive(shard), SOCKET_KEEPALIVE_MS);
    this.shards.push(shard);
    return shard;
  }

  /** One status for all sockets: connected only when every socket is. */
  private reportStatus(): void {
    const all = this.shards.map((s) => s.status);
    const status: ConnectionStatus = all.every((s) => s === "connected") ? "connected" : all.includes("disconnected") ? "disconnected" : "connecting";
    if (status === this.reported) return;
    this.reported = status;
    this.options.onStatus?.(status);
  }

  /** A rejected token will not start working by retrying; stop until the user fixes the settings. */
  private handleAuthFailed(): void {
    if (this.authFailed) return;
    this.authFailed = true;
    for (const { socket } of this.shards) socket.disconnect();
    this.options.onAuthFailed();
  }
}

/** A sync step 1 the server always answers: traffic both ways, without presence (see SOCKET_KEEPALIVE_MS). */
function keepAlive(shard: Shard): void {
  if (shard.status !== "connected") return; // the provider queues messages while disconnected
  const [provider] = shard.providers;
  provider?.forceSync();
}

function waitForSynced(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve) => {
    const onSynced = () => {
      if (!provider.isSynced) return;
      provider.off("synced", onSynced);
      resolve();
    };
    provider.on("synced", onSynced);
  });
}
