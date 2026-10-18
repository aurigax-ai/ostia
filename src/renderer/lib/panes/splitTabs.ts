import type { SplitNode } from '@/lib/layout/types'

export type SplitTabLayout = 'sideBySide' | 'stacked' | 'grid'

export function splitTabLayout(tab: SplitNode): SplitTabLayout {
  if (tab.children.some((c) => c.type !== 'pane')) return 'grid'
  return tab.direction === 'horizontal' ? 'sideBySide' : 'stacked'
}

const SEGMENT_MIN_WIDTH = 480

export function readableColumns(width: number): number {
  return Math.max(2, Math.floor(width / SEGMENT_MIN_WIDTH))
}
