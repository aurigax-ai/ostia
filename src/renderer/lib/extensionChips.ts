import type { ExtensionChip, ExtensionInfo, PaneChip, WorkspaceChip } from '@shared/extensions'
import { useMemo } from 'react'
import { extensionCommandId } from '../commands/extensionBridge'
import { commands } from '../commands/registry'
import { useExtensionsStore } from '../stores/extensionsStore'
import { openSidebarUrl } from './sidebarItems'
import { workspaceOfPane } from './workspaceActivity'

export interface ChipCatalogEntry {
  extId: string
  extName: string
  id: string
  title: string
}

export interface ShownChip extends ExtensionChip {
  paneId?: string
  workspaceId?: string
  title: string
  extName: string
}

type ChipSlots = Pick<ExtensionInfo, 'paneChips' | 'workspaceChips'>

function catalogOf(
  list: ExtensionInfo[],
  slots: (ext: ExtensionInfo) => ChipSlots[keyof ChipSlots],
): ChipCatalogEntry[] {
  return list
    .filter((ext) => ext.enabled)
    .flatMap((ext) =>
      slots(ext).map((chip) => ({
        extId: ext.id,
        extName: ext.name,
        id: chip.id,
        title: chip.title,
      })),
    )
}

export function chipCatalog(list: ExtensionInfo[]): ChipCatalogEntry[] {
  return catalogOf(list, (ext) => [...ext.paneChips, ...ext.workspaceChips])
}

export function paneChipCatalog(list: ExtensionInfo[]): ChipCatalogEntry[] {
  return catalogOf(list, (ext) => ext.paneChips)
}

export function workspaceChipCatalog(list: ExtensionInfo[]): ChipCatalogEntry[] {
  return catalogOf(list, (ext) => ext.workspaceChips)
}

function shown<C extends ExtensionChip>(
  chips: readonly C[],
  catalog: readonly ChipCatalogEntry[],
  belongs: (chip: C) => boolean,
): (C & { title: string; extName: string })[] {
  const out: (C & { title: string; extName: string })[] = []
  for (const entry of catalog) {
    const chip = chips.find((c) => belongs(c) && c.extId === entry.extId && c.id === entry.id)
    if (chip) out.push({ ...chip, title: entry.title, extName: entry.extName })
  }
  return out
}

export function chipsForPane(
  chips: readonly PaneChip[],
  catalog: readonly ChipCatalogEntry[],
  paneId: string | null,
): ShownChip[] {
  if (!paneId) return []
  return shown(chips, catalog, (c) => c.paneId === paneId)
}

export function chipsForWorkspace(
  chips: readonly WorkspaceChip[],
  catalog: readonly ChipCatalogEntry[],
  workspaceId: string | null,
): ShownChip[] {
  if (!workspaceId) return []
  return shown(chips, catalog, (c) => c.workspaceId === workspaceId)
}

export function promptExtensionChips(
  paneChips: readonly PaneChip[],
  workspaceChips: readonly WorkspaceChip[],
  catalog: readonly ChipCatalogEntry[],
  paneId: string | null,
  workspaceId: string | null,
): ShownChip[] {
  const own = chipsForPane(paneChips, catalog, paneId)
  const inherited = chipsForWorkspace(workspaceChips, catalog, workspaceId).filter(
    (w) => !own.some((p) => p.extId === w.extId && p.id === w.id),
  )
  return [...own, ...inherited]
}

export function useChipCatalog(): ChipCatalogEntry[] {
  const list = useExtensionsStore((s) => s.list)
  return useMemo(() => chipCatalog(list), [list])
}

export function usePaneChips(paneId: string | null): ShownChip[] {
  const list = useExtensionsStore((s) => s.list)
  const chips = useExtensionsStore((s) => s.chips)
  return useMemo(() => chipsForPane(chips, paneChipCatalog(list), paneId), [chips, list, paneId])
}

export function useWorkspaceChips(workspaceId: string | null): ShownChip[] {
  const list = useExtensionsStore((s) => s.list)
  const chips = useExtensionsStore((s) => s.workspaceChips)
  return useMemo(
    () => chipsForWorkspace(chips, workspaceChipCatalog(list), workspaceId),
    [chips, list, workspaceId],
  )
}

export function usePromptExtensionChips(paneId: string | null): ShownChip[] {
  const list = useExtensionsStore((s) => s.list)
  const paneChips = useExtensionsStore((s) => s.chips)
  const workspaceChips = useExtensionsStore((s) => s.workspaceChips)
  const workspaceId = paneId ? (workspaceOfPane(paneId) ?? null) : null
  return useMemo(
    () => promptExtensionChips(paneChips, workspaceChips, chipCatalog(list), paneId, workspaceId),
    [paneChips, workspaceChips, list, paneId, workspaceId],
  )
}

function chipCommandId(chip: ExtensionChip): string | null {
  if (!chip.command) return null
  const id = extensionCommandId(chip.extId, chip.command)
  return commands.has(id) ? id : null
}

function chipWorkspace(chip: Pick<ShownChip, 'paneId' | 'workspaceId'>): string | undefined {
  return chip.workspaceId ?? (chip.paneId ? (workspaceOfPane(chip.paneId) ?? undefined) : undefined)
}

export function openChipUrl(chip: Pick<ShownChip, 'paneId' | 'workspaceId'>, url: string): void {
  const workspaceId = chipWorkspace(chip)
  if (workspaceId) openSidebarUrl(workspaceId, url)
}

export function chipAction(
  chip: ExtensionChip & Pick<ShownChip, 'paneId' | 'workspaceId'>,
): (() => Promise<void>) | null {
  const url = chip.url
  if (url) return async () => openChipUrl(chip, url)
  const id = chipCommandId(chip)
  if (!id) return null
  const paneId = chip.paneId
  return async () => {
    if (paneId) await commands.exec('pane.focus', { paneId })
    await commands.exec(id)
  }
}
