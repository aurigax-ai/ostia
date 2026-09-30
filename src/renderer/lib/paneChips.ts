import type { ExtensionInfo, PaneChip } from '@shared/extensions'
import { useMemo } from 'react'
import { extensionCommandId } from '../commands/extensionBridge'
import { commands } from '../commands/registry'
import { useExtensionsStore } from '../stores/extensionsStore'
import { openSidebarUrl } from './sidebarItems'
import { workspaceOfPane } from './workspaceActivity'

export interface PaneChipCatalogEntry {
  extId: string
  extName: string
  id: string
  title: string
}

export interface ShownPaneChip extends PaneChip {
  title: string
  extName: string
}

export function paneChipCatalog(list: ExtensionInfo[]): PaneChipCatalogEntry[] {
  return list
    .filter((ext) => ext.enabled)
    .flatMap((ext) =>
      ext.paneChips.map((chip) => ({
        extId: ext.id,
        extName: ext.name,
        id: chip.id,
        title: chip.title,
      })),
    )
}

export function chipsForPane(
  chips: PaneChip[],
  catalog: PaneChipCatalogEntry[],
  paneId: string | null,
): ShownPaneChip[] {
  if (!paneId) return []
  const shown: ShownPaneChip[] = []
  for (const entry of catalog) {
    const chip = chips.find(
      (c) => c.paneId === paneId && c.extId === entry.extId && c.id === entry.id,
    )
    if (chip) shown.push({ ...chip, title: entry.title, extName: entry.extName })
  }
  return shown
}

export function usePaneChipCatalog(): PaneChipCatalogEntry[] {
  const list = useExtensionsStore((s) => s.list)
  return useMemo(() => paneChipCatalog(list), [list])
}

export function usePaneChips(paneId: string | null): ShownPaneChip[] {
  const catalog = usePaneChipCatalog()
  const chips = useExtensionsStore((s) => s.chips)
  return useMemo(() => chipsForPane(chips, catalog, paneId), [chips, catalog, paneId])
}

function paneChipCommandId(chip: PaneChip): string | null {
  if (!chip.command) return null
  const id = extensionCommandId(chip.extId, chip.command)
  return commands.has(id) ? id : null
}

export function paneChipAction(chip: PaneChip): (() => Promise<void>) | null {
  const url = chip.url
  if (url) {
    return async () => {
      const workspaceId = workspaceOfPane(chip.paneId)
      if (workspaceId) openSidebarUrl(workspaceId, url)
    }
  }
  const id = paneChipCommandId(chip)
  if (!id) return null
  return async () => {
    await commands.exec('pane.focus', { paneId: chip.paneId })
    await commands.exec(id)
  }
}
