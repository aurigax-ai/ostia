export const REMOTE_MAIL_TEXT_MAX = 16_000

export interface RemoteMailOut {
  id: string
  from: string
  to: string
  text: string
  ts: string
}

export interface RemoteMailIn {
  pane: string
  id: string
  to: string
  text: string
}

export type RemoteMailRequest =
  | { op: 'out'; host: string }
  | { op: 'stored'; host: string; id: string }
  | { op: 'in'; host: string; mail: RemoteMailIn }
  | { op: 'refused'; host: string; id: string; reason: string }
  | { op: 'link'; host: string; online: boolean; delivered?: number }

export type RemoteMailResult =
  | { ok: true; out?: RemoteMailOut[]; expired?: number }
  | { ok: false; error: string; message?: string }
