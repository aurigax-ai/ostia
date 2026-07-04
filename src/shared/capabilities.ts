/**
 * Capabilities gate every privileged control-plane action (spec §6, §6.1).
 * Posture: pane-scoped trust — a process in a pane holds the DEFAULTs for
 * that pane; elevated caps are granted per-pane by explicit user action.
 */
export type Capability =
  | 'drive-self' // act on the caller's own pane (default — pane-scoped)
  | 'read-board' // read the kanban/status board (default — pane-scoped)
  | 'send-other-pane' // inject input into a different pane (elevated — cross-boundary)
  | 'kill-pane' // close/kill a pane (elevated — cross-boundary)
  | 'workspace-wide' // act across the whole workspace (elevated — cross-boundary)
  | 'shell' // run a command in a terminal (elevated — dangerous)
  | 'destructive' // irreversible ops — gated regardless of caller (elevated — dangerous)
  | 'phone' // remote gateway access (elevated — cross-boundary)
  | 'notify' // fire a desktop notification (default — pane-scoped, low-risk)
  | 'process' // spawn/manage a background process (default — pane-scoped)
  | 'vault-read' // read secrets from the vault (default — pane-scoped)
  | 'vault-write' // write secrets to the vault (default — pane-scoped)
  | 'wiki-read' // read the project wiki/docs (default — pane-scoped, low-risk)
  | 'wiki-write' // write the project wiki/docs (default — pane-scoped)
  | 'board-write' // write the kanban/status board (default — pane-scoped)
  | 'browse' // drive the embedded browser (elevated — system-facing)
  | 'settings-read' // read settings.json (default — pane-scoped, low-risk)
  | 'settings-write' // write settings.json (elevated — system-facing)

/** Granted to every pane by default under the pane-scoped-trust posture. */
export const DEFAULT_CAPABILITIES: Capability[] = [
  'drive-self',
  'read-board',
  'notify',
  'wiki-read',
  'wiki-write',
  'settings-read',
  'board-write',
  'process',
  'vault-read',
  'vault-write',
]

/** Every recognized capability — used to validate human-authored grants (settings.json). */
export const ALL_CAPABILITIES: Capability[] = [
  'drive-self',
  'read-board',
  'send-other-pane',
  'kill-pane',
  'workspace-wide',
  'shell',
  'destructive',
  'phone',
  'notify',
  'process',
  'vault-read',
  'vault-write',
  'wiki-read',
  'wiki-write',
  'board-write',
  'browse',
  'settings-read',
  'settings-write',
]
