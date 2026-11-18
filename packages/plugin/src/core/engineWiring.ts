import * as Y from "yjs";
import { buildIndexDocName, isSyncablePath, isWindowsSafePath, windowsLookalikePath } from "@quilleaf/shared";
import { DocManager } from "./docManager";
import { EchoTrackingVault } from "./echoTrackingVault";
import { FileReconciler } from "./fileReconciler";
import { IndexApplier } from "./indexApplier";
import { LocalChangeHandler } from "./localChanges";
import { MassDeleteGuard } from "./massDeleteGuard";
import type { SyncNotice } from "./notices";
import type { DocPersistence, DocSyncer, DocSyncHandle, PersistedDoc, StoragePort, VaultPort } from "./ports";
import { RecordStore } from "./recordStore";
import { StartupScan } from "./startupScan";
import { TextHistory } from "./textHistory";
import { VaultIndex } from "./vaultIndex";

export interface Wiring {
  records: RecordStore;
  docs: DocManager;
  index: VaultIndex;
  indexSync: DocSyncHandle;
  indexPersisted: PersistedDoc;
  indexDoc: Y.Doc;
  reconciler: FileReconciler;
  local: LocalChangeHandler;
  applier: IndexApplier;
  echoes: EchoTrackingVault;
  scan: StartupScan;
  history: TextHistory;
}

export interface WiringInputs {
  vaultId: string;
  vault: VaultPort;
  storage: StoragePort;
  syncer: DocSyncer;
  persistence: DocPersistence;
  excludedPrefixes?: readonly string[];
}

export interface WiringHooks {
  now: () => number;
  notify: (notice: SyncNotice) => void;
  /** Either an editor-open fileId or the editor layer's path signal. */
  isOpenInEditor: (fileId: string | null, path: string) => boolean;
  massDelete: { threshold: number; windowMs: number };
  onTextChanged: (fileId: string) => void;
  requestRetry: (fileId: string) => void;
  requestPass: () => void;
}

export async function createWiring(inputs: WiringInputs, hooks: WiringHooks): Promise<Wiring> {
  const { vaultId, storage, syncer, persistence } = inputs;
  const echoes = new EchoTrackingVault(inputs.vault);
  const vault = echoes;
  const records = await RecordStore.load(storage);
  const docs = new DocManager({ vaultId, syncer, persistence, onTextChanged: hooks.onTextChanged });
  const indexDoc = new Y.Doc();
  const indexName = buildIndexDocName(vaultId);
  const indexPersisted = await persistence.attach(indexName, indexDoc);
  const indexSync = syncer.connect(indexName, indexDoc);
  const index = new VaultIndex(indexDoc);
  const history = new TextHistory();
  const isEligible = (path: string) => isSyncablePath(path, inputs.excludedPrefixes);
  // Local files under a name Windows cannot hold (`a.md `, `C:/a.md`) stay in view, so a synced note renamed to one
  // is held at its index path instead of deleted everywhere; index entries still pass isEligible alone.
  const isLocallyEligible = (path: string) =>
    isEligible(path) || (!isWindowsSafePath(path) && isEligible(windowsLookalikePath(path)));
  const { now, notify, isOpenInEditor } = hooks;
  const reconciler = new FileReconciler({ vault, records, docs, now, notify, history, requestRetry: hooks.requestRetry });
  const guard = new MassDeleteGuard({ ...hooks.massDelete, now });
  const local = new LocalChangeHandler({
    vault, index, records, docs, reconciler, guard, now, notify, isOpenInEditor, isEligible: isLocallyEligible,
  });
  const applier = new IndexApplier({ vault, index, records, docs, reconciler, isEligible, notify, requestPass: hooks.requestPass });
  const scan = new StartupScan({ vault, records, reconciler, local, applier, isEligible: isLocallyEligible, notify });
  return { records, docs, index, indexSync, indexPersisted, indexDoc, reconciler, local, applier, echoes, scan, history };
}
