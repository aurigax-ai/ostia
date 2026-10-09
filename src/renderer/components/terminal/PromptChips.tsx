import { Hint } from '@/components/common/Hint'
import { MenuContent, MenuItem } from '@/components/common/Menu'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { fmt, useDict } from '@/i18n/useDict'
import { type ChipCatalogEntry, chipAction } from '@/lib/extensionChips'
import type { ResolvedChip } from '@/lib/promptChips'
import { promptLine } from '@/lib/promptChips'
import { useUIStore } from '@/stores/uiStore'
import {
  CalendarBlankIcon,
  CheckCircleIcon,
  ClockIcon,
  CopyIcon,
  CubeIcon,
  DesktopIcon,
  FilePyIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  HexagonIcon,
  type Icon,
  PackageIcon,
  PencilSimpleIcon,
  PuzzlePieceIcon,
  TimerIcon,
  UserIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import type { Dict } from '@shared/dict'
import { type CoreChipId, type PromptSeparator, separatorText } from '@shared/promptSettings'

const CORE_CHIP_ICONS: Record<CoreChipId, Icon> = {
  conda: PackageIcon,
  virtualenv: FilePyIcon,
  node: HexagonIcon,
  cwd: FolderSimpleIcon,
  user: UserIcon,
  host: DesktopIcon,
  kube: CubeIcon,
  date: CalendarBlankIcon,
  time12: ClockIcon,
  time24: ClockIcon,
  exitCode: CheckCircleIcon,
  duration: TimerIcon,
}

export function chipIcon(core: CoreChipId | null, tone: ResolvedChip['tone'] = 'default'): Icon {
  if (!core) return PuzzlePieceIcon
  if (core === 'exitCode' && tone === 'error') return XCircleIcon
  return CORE_CHIP_ICONS[core]
}

export function chipName(d: Dict, id: string, catalog: readonly ChipCatalogEntry[]): string {
  if (id in d.prompt.chip) return d.prompt.chip[id as CoreChipId]
  const info = catalog.find((c) => `${c.extId}.${c.id}` === id)
  return fmt(d.prompt.extensionChip, { name: info?.title ?? id })
}

function chipTooltip(d: Dict, chip: ResolvedChip): string | undefined {
  if (chip.core === 'exitCode') return fmt(d.prompt.exitTooltip, { code: chip.text })
  if (chip.core === 'duration') return fmt(d.prompt.durationTooltip, { duration: chip.text })
  return chip.tooltip
}

export function PromptChip({
  chip,
  label,
  onActivate,
}: {
  chip: ResolvedChip
  label: string
  onActivate?: () => void
}): JSX.Element {
  const d = useDict()
  const ChipIcon = chipIcon(chip.core, chip.tone)
  const tooltip = chipTooltip(d, chip)
  const body = (
    <>
      <ChipIcon size={12} aria-hidden="true" />
      <span className="prompt-chip-text">{chip.text}</span>
    </>
  )
  const common = {
    className: 'prompt-chip',
    'data-chip': chip.id,
    'data-tone': chip.tone,
    'aria-label': fmt(d.prompt.chipLabel, { label, text: chip.text }),
  }
  const element = onActivate ? (
    <button type="button" {...common} onMouseDown={(e) => e.preventDefault()} onClick={onActivate}>
      {body}
    </button>
  ) : (
    <span {...common}>{body}</span>
  )
  return tooltip ? <Hint label={tooltip}>{element}</Hint> : element
}

export function PromptChipRow({
  paneId,
  chips,
  catalog,
  cwd,
  separator,
  showSeparator,
}: {
  paneId: string
  chips: readonly ResolvedChip[]
  catalog: readonly ChipCatalogEntry[]
  cwd?: string
  separator: PromptSeparator
  showSeparator: boolean
}): JSX.Element {
  const d = useDict()
  const sep = showSeparator ? separatorText(separator) : ''
  const activate = (chip: ResolvedChip): (() => void) | undefined => {
    if (chip.core === 'cwd') return () => useUIStore.getState().showFiles()
    const ext = chip.extension
    const action = ext ? chipAction(ext) : null
    return action ? () => void action() : undefined
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <ul className="prompt-chips" aria-label={d.prompt.chips}>
            {chips.map((chip) => (
              <li key={chip.id} className="prompt-chip-slot">
                <PromptChip
                  chip={chip}
                  label={chipName(d, chip.id, catalog)}
                  onActivate={activate(chip)}
                />
              </li>
            ))}
            {sep ? (
              <li className="prompt-separator" aria-hidden="true">
                {sep}
              </li>
            ) : null}
          </ul>
        }
      />
      <MenuContent>
        <MenuItem
          icon={PencilSimpleIcon}
          onClick={() => useUIStore.getState().openSettings('prompt', { previewPaneId: paneId })}
        >
          {d.prompt.edit}
        </MenuItem>
        <MenuItem
          icon={FolderOpenIcon}
          disabled={!cwd}
          onClick={() => useUIStore.getState().showFiles()}
        >
          {d.prompt.revealCwd}
        </MenuItem>
        <ContextMenuSeparator />
        <MenuItem
          icon={CopyIcon}
          onClick={() => void navigator.clipboard.writeText(promptLine(chips, separator))}
        >
          {d.prompt.copyPrompt}
        </MenuItem>
        <MenuItem
          icon={CopyIcon}
          disabled={!cwd}
          onClick={() => cwd && void navigator.clipboard.writeText(cwd)}
        >
          {d.prompt.copyCwd}
        </MenuItem>
      </MenuContent>
    </ContextMenu>
  )
}
