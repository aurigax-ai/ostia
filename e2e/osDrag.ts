import type { Locator, Page } from './test'

type DragStep = 'dragEnter' | 'dragOver' | 'drop'

export interface Point {
  x: number
  y: number
}

export async function dragFiles(win: Page, paths: string[], modifiers = 0) {
  const cdp = await win.context().newCDPSession(win)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  return {
    send: (type: DragStep, at: Point) =>
      cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data, modifiers }),
    done: () => cdp.detach(),
  }
}

export async function dropFiles(
  win: Page,
  paths: string[],
  at: Point,
  modifiers = 0,
): Promise<void> {
  const drag = await dragFiles(win, paths, modifiers)
  for (const step of ['dragEnter', 'dragOver', 'drop'] as const) await drag.send(step, at)
  await drag.done()
}

export async function centerOf(target: Locator): Promise<Point> {
  const box = await target.first().boundingBox()
  if (!box) throw new Error('no box for the drop target')
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}
