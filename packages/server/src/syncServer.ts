import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import { MAX_WS_PAYLOAD_BYTES } from "@quilleaf/shared";
import { AuthorizationError, authorize, type ConnectionContext } from "./authorize";
import { handleBlobRequest } from "./blobRoutes";
import type { BlobStore } from "./blobStore";
import type { DocumentStore } from "./documentStore";
import type { Logger } from "./logger";
import type { TokenStore } from "./tokenStore";

const DEFAULT_STORE_DEBOUNCE_MS = 2000;
const MAX_LOGGED_NAME_LENGTH = 120;
/** Node's 5 min default would cut a 50 MiB upload slower than ~170 KiB/s (a phone on a weak network). */
const HTTP_REQUEST_TIMEOUT_MS = 30 * 60_000;

export interface SyncServerOptions {
  port: number;
  address: string;
  documents: DocumentStore;
  tokens: TokenStore;
  blobs: BlobStore;
  logger: Logger;
  storeDebounceMs?: number;
}

export function createSyncServer(options: SyncServerOptions): Server<ConnectionContext> {
  const { documents, tokens, blobs, logger } = options;
  const server = new Server<ConnectionContext>({
    port: options.port,
    address: options.address,
    quiet: true,
    stopOnSignals: false,
    debounce: options.storeDebounceMs ?? DEFAULT_STORE_DEBOUNCE_MS,
    websocketOptions: { maxPayload: MAX_WS_PAYLOAD_BYTES },
    extensions: [
      new Database({
        fetch: async ({ documentName }) => documents.load(documentName),
        store: async ({ documentName, state }) => documents.save(documentName, state),
      }),
    ],
    async onRequest({ request, response }) {
      const resolveVaultId = (token: string) => tokens.resolveVaultId(token);
      // throwing null is how a Hocuspocus hook says the request is answered
      if (await handleBlobRequest(request, response, { blobs, resolveVaultId, logger })) throw null;
    },
    async onAuthenticate({ token, documentName, socketId }) {
      const loggedName = documentName.slice(0, MAX_LOGGED_NAME_LENGTH);
      try {
        const context = authorize({ token, documentName }, (candidate) => tokens.resolveVaultId(candidate));
        logger.log("info", "auth.accepted", { socketId, documentName: loggedName });
        return context;
      } catch (error) {
        if (error instanceof AuthorizationError) {
          logger.log("warn", "auth.rejected", { socketId, documentName: loggedName, code: error.code });
        }
        throw error;
      }
    },
  });
  server.httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  return server;
}