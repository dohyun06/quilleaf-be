import { isWindowsSafePath, isWithinSizeLimit } from "@quilleaf/shared";
import { DISK_ORIGIN, type DocManager } from "./docManager";
import type { FileReconciler } from "./fileReconciler";
import type { MassDeleteGuard } from "./massDeleteGuard";
import type { SyncNotice } from "./notices";
import type { VaultPort } from "./ports";
import type { RecordStore } from "./recordStore";
import { applyMinimalDiff } from "./textDiff";
import type { VaultIndex } from "./vaultIndex";

export interface LocalChangeDeps {
  vault: VaultPort;
  index: VaultIndex;
  records: RecordStore;
  docs: DocManager;
  reconciler: FileReconciler;
  guard: MassDeleteGuard;
  now: () => number;
  notify: (notice: SyncNotice) => void;
  isEligible: (path: string) => boolean;
  isOpenInEditor: (fileId: string | null, path: string) => boolean;
}

interface PendingDelete {
  fileId: string;
  path: string;
  base: string | null;
}

/** Turns this device's vault events into index and document changes (spec §4.4). */
export class LocalChangeHandler {
  private readonly pendingDeletes = new Map<string, PendingDelete>();
  private pausedDeletes: PendingDelete[] = [];
  private readonly oversizeNotified = new Set<string>();
  private readonly unsafeNameNotified = new Set<string>();

  constructor(private readonly deps: LocalChangeDeps) {}

  async handleCreate(path: string): Promise<void> {
    if (!this.deps.isEligible(path)) return;
    const knownId = this.deps.records.findIdByPath(path);
    if (knownId) return this.reconcileUnlessOpen(knownId, path);
    const live = this.deps.index.findLiveByPath(path);
    // A live entry this device still tracks at another path is a remote move the index pass has not applied yet.
    // Taking it over would orphan the file at the old path; instead this file is registered as its own entry and
    // the same-path rule (spec §4.4) settles the collision on every device.
    if (live && !this.deps.records.get(live.fileId)) return this.adoptRemoteEntry(live.fileId, path);
    const text = await this.deps.vault.read(path);
    if (text === null) return;
    // A synced note renamed as delete + create: moveTracked holds a name Windows cannot hold instead of dropping it.
    // Before the size check, or an oversize rename would leave the delete to remove the note everywhere.
    const renamed = this.takeRenamedFrom(path, text);
    if (renamed) return this.moveTracked(renamed.fileId, path);
    if (!this.fitsSizeLimit(path, text)) return;
    if (!isWindowsSafePath(path)) return this.notifyUnsafeName(path, null);
    await this.registerNew(path, text);
  }

  async handleModify(path: string): Promise<void> {
    if (!this.deps.isEligible(path)) return;
    const fileId = this.deps.records.findIdByPath(path);
    if (fileId) return this.reconcileUnlessOpen(fileId, path);
    if (this.deps.isOpenInEditor(null, path)) return;
    return this.handleCreate(path);
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const fileId = this.deps.records.findIdByPath(oldPath);
    if (!fileId) return this.handleCreate(newPath);
    if (!this.deps.isEligible(newPath)) return this.handleDelete(oldPath);
    await this.moveTracked(fileId, newPath);
  }

  /** Deletes wait for the rename-pair window; the engine then calls commitPendingDeletes(). */
  handleDelete(path: string): void {
    const fileId = this.deps.records.findIdByPath(path);
    if (!fileId || this.pendingDeletes.has(fileId)) return;
    this.pendingDeletes.set(fileId, { fileId, path, base: this.deps.records.get(fileId)?.base ?? null });
  }

  async commitPendingDeletes(): Promise<void> {
    const batch = [...this.pendingDeletes.values()];
    this.pendingDeletes.clear();
    if (batch.length === 0) return;
    if (this.pausedDeletes.length > 0 || this.deps.guard.record(batch.length)) {
      this.pausedDeletes.push(...batch);
      this.deps.notify({ kind: "mass-delete-paused", paths: this.pausedDeletes.map((item) => item.path) });
      return;
    }
    for (const item of batch) await this.commitDelete(item);
  }

  async confirmPausedDeletes(): Promise<void> {
    const paused = this.takePaused();
    for (const item of paused) await this.commitDelete(item);
  }

  async restorePausedDeletes(): Promise<void> {
    const paused = this.takePaused();
    for (const item of paused) {
      const { text } = await this.deps.docs.open(item.fileId);
      await this.deps.vault.replace(item.path, null, text.toString());
    }
  }

  private takePaused(): PendingDelete[] {
    const paused = this.pausedDeletes;
    this.pausedDeletes = [];
    this.deps.guard.reset();
    return paused;
  }

  private async commitDelete(item: PendingDelete): Promise<void> {
    if ((await this.deps.vault.read(item.path)) !== null) return; // the file came back
    this.deps.index.markDeleted(item.fileId);
    await this.deps.records.delete(item.fileId);
  }

  private async adoptRemoteEntry(fileId: string, path: string): Promise<void> {
    await this.deps.records.set(fileId, { path, base: null });
    await this.deps.reconciler.reconcile(fileId);
  }

  private async moveTracked(fileId: string, newPath: string): Promise<void> {
    const record = this.deps.records.get(fileId);
    const base = record?.base ?? null;
    if (isWindowsSafePath(newPath)) {
      this.deps.index.rename(fileId, newPath);
      await this.deps.records.set(fileId, { path: newPath, base });
    } else {
      // Other devices keep the note at its index path (a Windows device could not follow); this file keeps syncing.
      const heldIndexPath = this.deps.index.get(fileId)?.path ?? record?.path ?? newPath;
      await this.deps.records.set(fileId, { path: newPath, base, heldIndexPath });
      this.notifyUnsafeName(newPath, heldIndexPath);
    }
    // A renamed open note keeps its editor: the disk may hold a lagging autosave that must not be merged again.
    await this.reconcileUnlessOpen(fileId, newPath);
  }

  /** The editor owns open files (spec §4.1); only an autosave that matches the Y.Text is taken, as the new base. */
  private reconcileUnlessOpen(fileId: string, path: string): Promise<void> {
    if (this.deps.isOpenInEditor(fileId, path)) return this.deps.reconciler.acceptEditorSave(fileId);
    return this.deps.reconciler.reconcile(fileId);
  }

  /** Spec §5: oversize files are not synced; one notice per path until it fits again. */
  private fitsSizeLimit(path: string, text: string): boolean {
    if (isWithinSizeLimit(text)) {
      this.oversizeNotified.delete(path);
      return true;
    }
    if (!this.oversizeNotified.has(path)) {
      this.oversizeNotified.add(path);
      this.deps.notify({ kind: "file-too-large", path });
    }
    return false;
  }

  /** Once per path per session: the startup scan and every edit would otherwise repeat it. */
  private notifyUnsafeName(path: string, keptPath: string | null): void {
    if (this.unsafeNameNotified.has(path)) return;
    this.unsafeNameNotified.add(path);
    this.deps.notify({ kind: "windows-unsafe-name", path, keptPath });
  }

  private async registerNew(path: string, text: string): Promise<void> {
    const fileId = this.deps.index.register(path, this.deps.now());
    const opened = await this.deps.docs.open(fileId);
    applyMinimalDiff(opened.text, text, DISK_ORIGIN);
    await this.deps.records.set(fileId, { path, base: text });
  }

  /**
   * The pending delete a create is the other half of. Same text is a rename (never empty text: any two empty notes
   * would match). A create under a name Windows cannot hold, or of a note held under one, pairs whatever its text:
   * unpaired, the delete would remove the note from every other device, and a wrong pair only renames and edits a
   * note the user deleted. Then preferred: the note's index path (renamed back), its file name (a folder rename), the oldest.
   */
  private takeRenamedFrom(path: string, text: string): PendingDelete | null {
    const sameText = (item: PendingDelete) => text !== "" && item.base === text;
    const anyText = !isWindowsSafePath(path);
    const candidates = [...this.pendingDeletes.values()].filter((item) => anyText || sameText(item) || this.isHeld(item.fileId));
    const match =
      candidates.find(sameText) ??
      candidates.find((item) => this.deps.index.get(item.fileId)?.path === path) ??
      candidates.find((item) => fileName(item.path) === fileName(path)) ??
      candidates[0];
    if (match) this.pendingDeletes.delete(match.fileId);
    return match ?? null;
  }

  private isHeld(fileId: string): boolean {
    return this.deps.records.get(fileId)?.heldIndexPath !== undefined;
  }
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
