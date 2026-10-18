import type { DiffLayout } from '@/lib/settings/browserEditorSettings'

export const INLINE_BELOW_PX = 900

export function isInlineDiff(layout: DiffLayout, width: number): boolean {
  if (layout === 'auto') return width > 0 && width < INLINE_BELOW_PX
  return layout === 'inline'
}
