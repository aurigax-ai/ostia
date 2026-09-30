export type SizeAction =
  | { type: 'none' }
  | { type: 'attach'; cols: number; rows: number }
  | { type: 'resize'; cols: number; rows: number }

export interface SizeDecisionInput {
  fitted: boolean
  attached: boolean
  cols: number
  rows: number
  last: { cols: number; rows: number }
}

export function nextSizeAction({
  fitted,
  attached,
  cols,
  rows,
  last,
}: SizeDecisionInput): SizeAction {
  if (!fitted) return { type: 'none' }
  if (cols <= 0 || rows <= 0) return { type: 'none' }
  if (!attached) return { type: 'attach', cols, rows }
  if (cols !== last.cols || rows !== last.rows) return { type: 'resize', cols, rows }
  return { type: 'none' }
}

const COMMAND_START_MARK = '\x1b]133;C'

export function isPromptRepaint(held: string): boolean {
  return !held.includes(COMMAND_START_MARK)
}
