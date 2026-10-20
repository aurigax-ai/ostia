import { type LineAnchor, useBlocksStore } from '../src/renderer/stores/terminal/blocksStore'

export function idlePrompt(paneId: string, cwd: string): LineAnchor {
  const anchor = { line: 0 }
  const blocks = useBlocksStore.getState()
  blocks.promptStart(paneId, anchor, cwd)
  blocks.promptEnd(paneId, { line: 0 })
  return anchor
}
