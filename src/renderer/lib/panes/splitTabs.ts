import type { SplitNode } from '@/layout/types'

export type SplitTabLayout = 'sideBySide' | 'stacked' | 'grid'

export function splitTabLayout(tab: SplitNode): SplitTabLayout {
  if (tab.children.some((c) => c.type !== 'pane')) return 'grid'
  return tab.direction === 'horizontal' ? 'sideBySide' : 'stacked'
}
