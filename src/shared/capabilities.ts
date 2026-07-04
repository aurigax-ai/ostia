/**
 * Capabilities gate every privileged control-plane action (spec §6, §6.1).
 * Posture: pane-scoped trust — a process in a pane holds the DEFAULTs for
 * that pane; elevated caps are granted per-pane by explicit user action.
 */
export type Capability =
  | 'drive-self' // act on the caller's own pane (default)
  | 'read-board' // read the kanban/status board (default)
  | 'send-other-pane' // inject input into a different pane (elevated)
  | 'kill-pane' // close/kill a pane (elevated)
  | 'workspace-wide' // act across the whole workspace (elevated)
  | 'shell' // run a command in a terminal (elevated)
  | 'destructive' // irreversible ops — gated regardless of caller
  | 'phone' // remote gateway access (elevated)
  | 'notify' // fire a desktop notification (default — low-risk)

/** Granted to every pane by default under the pane-scoped-trust posture. */
export const DEFAULT_CAPABILITIES: Capability[] = ['drive-self', 'read-board', 'notify']
