export interface TabSpan {
  id: string
  left: number
  right: number
}

export interface HiddenTabs {
  start: string[]
  end: string[]
}

export function hiddenTabs(view: { left: number; right: number }, tabs: readonly TabSpan[]) {
  const hidden: HiddenTabs = { start: [], end: [] }
  for (const tab of tabs) {
    const middle = (tab.left + tab.right) / 2
    if (middle < view.left) hidden.start.push(tab.id)
    else if (middle > view.right) hidden.end.push(tab.id)
  }
  return hidden
}

export function revealScroll(
  scrollLeft: number,
  viewWidth: number,
  tabLeft: number,
  tabWidth: number,
): number {
  if (tabLeft < scrollLeft) return tabLeft
  const overshoot = tabLeft + tabWidth - (scrollLeft + viewWidth)
  return overshoot > 0 ? Math.min(tabLeft, scrollLeft + overshoot) : scrollLeft
}
