import type { DragEvent, RefObject } from 'react'
import { commands } from '@/commands/registry'
import { firstPaneId } from '@/lib/layout/tree'
import type { PaneNode, TabNode } from '@/lib/layout/types'
import { dropZoneAt, paneDropTarget, type TabDrop, tabDropTarget } from '@/lib/panes/dropZone'
import { dropPaneOn, isPaneDrag, PANE_DND, reportForeignDrop } from '@/lib/panes/paneDrag'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'

export function paneDropHandlers({
  tabs,
  shown,
  frameRef,
}: {
  tabs: TabNode[]
  shown: PaneNode
  frameRef: RefObject<HTMLDivElement | null>
}) {
  const tabIds = tabs.map((t) => t.id)
  const slot = { tabIds, shownId: shown.id }
  const tabFocus = (id: string): string => {
    const tab = tabs.find((t) => t.id === id)
    return tab ? firstPaneId(tab) : id
  }

  const zoneAt = (e: DragEvent<HTMLElement>) => {
    const rect = frameRef.current?.getBoundingClientRect()
    return rect ? dropZoneAt(rect, e.clientX, e.clientY) : 'center'
  }

  const onLayerDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const zone = zoneAt(e)
    if (!paneDropTarget(slot, usePaneDnd.getState().sourceId, zone)) {
      e.dataTransfer.dropEffect = 'none'
      usePaneDnd.getState().leave(shown.id)
      return
    }
    e.dataTransfer.dropEffect = 'move'
    usePaneDnd.getState().setOver(shown.id, zone)
  }

  const onLayerDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(PANE_DND)
    const zone = zoneAt(e)
    const target = sourceId ? paneDropTarget(slot, sourceId, zone) : null
    if (!target) {
      usePaneDnd.getState().dropped()
      return
    }
    dropPaneOn(sourceId, tabFocus(target.targetId), target.zone)
  }

  const hoveredTab = (e: DragEvent<HTMLElement>): TabDrop | null => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab-id]')
    const targetId = tab?.dataset.tabId
    if (!tab || !targetId) return null
    const rect = tab.getBoundingClientRect()
    return { targetId, after: e.clientX > rect.left + rect.width / 2 }
  }

  const onHeaderDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    const target = tabDropTarget(tabIds, usePaneDnd.getState().sourceId, hoveredTab(e))
    if (!target) {
      usePaneDnd.getState().leave(shown.id)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    usePaneDnd.getState().setOver(shown.id, 'center', target)
  }

  const onHeaderDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(PANE_DND)
    const local = usePaneDnd.getState().sourceId === sourceId
    const target = sourceId ? tabDropTarget(tabIds, local ? sourceId : null, hoveredTab(e)) : null
    usePaneDnd.getState().dropped()
    if (!target) return
    if (local) {
      void commands.exec('pane.moveTab', {
        sourceId,
        targetId: target.targetId,
        after: target.after,
      })
      return
    }
    reportForeignDrop(sourceId, { paneId: tabFocus(target.targetId), zone: 'center' })
  }

  return { tabIds, onLayerDragOver, onLayerDrop, onHeaderDragOver, onHeaderDrop }
}
