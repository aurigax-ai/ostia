import type { Bzip2Problem } from './bzip2'

export type ToBzip2 = { type: 'input'; chunk: Uint8Array } | { type: 'end' } | { type: 'pull' }

export type FromBzip2 =
  | { type: 'data'; chunk: Uint8Array }
  | { type: 'need' }
  | { type: 'done' }
  | { type: 'error'; problem: Bzip2Problem }
