/** User-facing events. Plan 2 turns them into Obsidian notices and status bar text. */
export type SyncNotice =
  | { kind: "waiting-for-first-sync" }
  | { kind: "conflict-copy"; path: string; copyPath: string }
  | { kind: "file-too-large"; path: string }
  /** `keptPath`: the name other devices keep for a renamed note; null for a new note that is not synced at all. */
  | { kind: "windows-unsafe-name"; path: string; keptPath: string | null }
  | { kind: "mass-delete-paused"; paths: string[] }
  | { kind: "task-failed"; message: string };
