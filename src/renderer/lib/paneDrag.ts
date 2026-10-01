import type { ScreenPoint } from '@shared/types'
import { usePaneDnd } from '../stores/paneDndStore'
import { endedOutside } from './dropZone'
import {
  canMovePane,
  movePaneToDropWindow,
  movePaneToNewWindow,
  moveWorkspaceToNewWindow,
} from './windowHandoff'

export const PANE_DND = 'application/x-pine-pane'

const FOREIGN_DRAG_IDLE_MS = 400

let origin: ScreenPoint | null = null

interface DragPoint {
  clientX: number
  clientY: number
  screenX: number
  screenY: number
}

export function isPaneDrag(types: readonly string[]): boolean {
  return types.includes(PANE_DND)
}

export function beginDrag(e: DragPoint): void {
  origin = { x: e.screenX - e.clientX, y: e.screenY - e.clientY }
}

export function beginPaneDrag(paneId: string, e: DragPoint): void {
  beginDrag(e)
  requestAnimationFrame(() => usePaneDnd.getState().start(paneId))
}

interface DragEndEvent extends DragPoint {
  dataTransfer: { dropEffect: string } | null
}

function finish(e: DragEndEvent): { droppedHere: boolean; outside: boolean; point: ScreenPoint } {
  const point = { x: e.screenX, y: e.screenY }
  const outside = endedOutside(
    {
      dropEffect: e.dataTransfer?.dropEffect ?? 'none',
      point,
      origin: origin ?? { x: window.screenX, y: window.screenY },
    },
    { width: window.innerWidth, height: window.innerHeight },
  )
  const { droppedHere } = usePaneDnd.getState()
  origin = null
  requestAnimationFrame(() => usePaneDnd.getState().reset())
  usePaneDnd.getState().reset()
  return { droppedHere, outside, point }
}

async function settlePaneDrag(
  workspaceId: string,
  paneId: string,
  outside: boolean,
  point: ScreenPoint,
): Promise<void> {
  if (!canMovePane(workspaceId, paneId)) return
  if (await window.pine.windows.landing(paneId)) {
    await movePaneToDropWindow(workspaceId, paneId)
    return
  }
  if (outside) await movePaneToNewWindow(workspaceId, paneId, point)
}

export function endPaneDrag(workspaceId: string | null, paneId: string, e: DragEndEvent): void {
  const { droppedHere, outside, point } = finish(e)
  if (workspaceId && !droppedHere) void settlePaneDrag(workspaceId, paneId, outside, point)
}

export function endWorkspaceDrag(workspaceId: string, e: DragEndEvent): void {
  const { outside, point } = finish(e)
  if (outside) void moveWorkspaceToNewWindow(workspaceId, point)
}

export function startPaneDragTracking(): () => void {
  let idle: ReturnType<typeof setTimeout> | null = null
  const endForeign = (): void => {
    if (idle) clearTimeout(idle)
    idle = null
    const s = usePaneDnd.getState()
    if (s.dragging && s.sourceId === null) s.reset()
  }
  const watch = (): void => {
    if (usePaneDnd.getState().sourceId !== null) return
    if (idle) clearTimeout(idle)
    idle = setTimeout(endForeign, FOREIGN_DRAG_IDLE_MS)
  }
  const enter = (e: DragEvent): void => {
    if (!isPaneDrag([...(e.dataTransfer?.types ?? [])])) return
    if (!usePaneDnd.getState().dragging) usePaneDnd.getState().start(null)
    watch()
  }
  const over = (e: DragEvent): void => {
    if (isPaneDrag([...(e.dataTransfer?.types ?? [])])) watch()
  }
  document.addEventListener('dragenter', enter)
  document.addEventListener('dragover', over)
  document.addEventListener('drop', endForeign)
  return () => {
    endForeign()
    document.removeEventListener('dragenter', enter)
    document.removeEventListener('dragover', over)
    document.removeEventListener('drop', endForeign)
  }
}
