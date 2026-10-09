import { extensionCommandId } from '@/commands/extensionBridge'
import { commands } from '@/commands/registry'
import { currentDict, useDict } from '@/i18n/useDict'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { openSidebarUrl } from '@/lib/sidebar/sidebarItems'
import { useCoreWatch } from '@/lib/workspaces/coreWatch'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import type { Dict } from '@shared/app/dict'
import {
  GIT_BRANCH_CHIP,
  GIT_DIFF_STATS_CHIP,
  GIT_SOURCE,
  PORTS_CHIP,
  PORTS_SOURCE,
  SSH_CHIP,
  isCoreSource,
} from '@shared/boards/git'
import type { ExtensionChip, ExtensionInfo, PaneChip, WorkspaceChip } from '@shared/extensions'
import { useMemo } from 'react'

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

export function corePaneChips(d: Dict): ChipCatalogEntry[] {
  return [{ extId: PORTS_SOURCE, extName: d.ports.title, id: SSH_CHIP, title: d.ports.sshChip }]
}

export function coreWorkspaceChips(d: Dict): ChipCatalogEntry[] {
  return [
    { extId: GIT_SOURCE, extName: d.git.title, id: GIT_BRANCH_CHIP, title: d.git.branchChip },
    {
      extId: GIT_SOURCE,
      extName: d.git.title,
      id: GIT_DIFF_STATS_CHIP,
      title: d.git.diffStatsChip,
    },
    { extId: PORTS_SOURCE, extName: d.ports.title, id: PORTS_CHIP, title: d.ports.portsChip },
  ]
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

export function everyChip(list: ExtensionInfo[], d: Dict = currentDict()): ChipCatalogEntry[] {
  return [...coreWorkspaceChips(d), ...corePaneChips(d), ...chipCatalog(list)]
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
  const d = useDict()
  return useMemo(() => everyChip(list, d), [list, d])
}

export function usePaneChips(paneId: string | null): ShownChip[] {
  const list = useExtensionsStore((s) => s.list)
  const chips = useExtensionsStore((s) => s.chips)
  const d = useDict()
  useCoreWatch('ports', paneId ? workspaceOfPane(paneId) : null)
  return useMemo(
    () => chipsForPane(chips, [...corePaneChips(d), ...paneChipCatalog(list)], paneId),
    [chips, list, paneId, d],
  )
}

export function useWorkspaceChips(workspaceId: string | null): ShownChip[] {
  const list = useExtensionsStore((s) => s.list)
  const chips = useExtensionsStore((s) => s.workspaceChips)
  const d = useDict()
  useCoreWatch('git', workspaceId)
  useCoreWatch('ports', workspaceId)
  return useMemo(
    () =>
      chipsForWorkspace(
        chips,
        [...coreWorkspaceChips(d), ...workspaceChipCatalog(list)],
        workspaceId,
      ),
    [chips, list, workspaceId, d],
  )
}

export function usePromptExtensionChips(
  paneId: string | null,
  order: readonly string[],
  active: boolean,
): ShownChip[] {
  const list = useExtensionsStore((s) => s.list)
  const paneChips = useExtensionsStore((s) => s.chips)
  const workspaceChips = useExtensionsStore((s) => s.workspaceChips)
  const workspaceId = paneId ? (workspaceOfPane(paneId) ?? null) : null
  const d = useDict()
  const wants = (source: string): boolean =>
    active && order.some((id) => id.startsWith(`${source}.`))
  useCoreWatch('git', workspaceId, wants(GIT_SOURCE))
  useCoreWatch('ports', workspaceId, wants(PORTS_SOURCE))
  return useMemo(
    () => promptExtensionChips(paneChips, workspaceChips, everyChip(list, d), paneId, workspaceId),
    [paneChips, workspaceChips, list, paneId, workspaceId, d],
  )
}

function chipCommandId(chip: ExtensionChip): string | null {
  if (!chip.command) return null
  const id = isCoreSource(chip.extId) ? chip.command : extensionCommandId(chip.extId, chip.command)
  return commands.has(id) ? id : null
}

function chipWorkspace(chip: Pick<ShownChip, 'paneId' | 'workspaceId'>): string | undefined {
  return chip.workspaceId ?? (chip.paneId ? (workspaceOfPane(chip.paneId) ?? undefined) : undefined)
}

export function openChipUrl(chip: Pick<ShownChip, 'paneId' | 'workspaceId'>, url: string): void {
  const workspaceId = chipWorkspace(chip)
  if (workspaceId) openSidebarUrl(workspaceId, url, 'human')
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
