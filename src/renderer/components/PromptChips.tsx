import {
  CalendarBlankIcon,
  CheckCircleIcon,
  ClockIcon,
  CubeIcon,
  DesktopIcon,
  FilePyIcon,
  FolderSimpleIcon,
  HexagonIcon,
  type Icon,
  PackageIcon,
  PuzzlePieceIcon,
  TimerIcon,
  UserIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import { type CoreChipId, type PromptSeparator, separatorText } from '@shared/promptSettings'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import type { ContributedChipInfo, ResolvedChip } from '../lib/promptChips'
import { promptLine } from '../lib/promptChips'
import { useUIStore } from '../stores/uiStore'
import { Hint } from './Hint'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'

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

export function chipName(d: Dict, id: string, catalog: readonly ContributedChipInfo[]): string {
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
    'aria-label': `${label}: ${chip.text}`,
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
  workspaceId,
  chips,
  catalog,
  cwd,
  separator,
  showSeparator,
}: {
  paneId: string
  workspaceId: string
  chips: readonly ResolvedChip[]
  catalog: readonly ContributedChipInfo[]
  cwd?: string
  separator: PromptSeparator
  showSeparator: boolean
}): JSX.Element {
  const d = useDict()
  const sep = showSeparator ? separatorText(separator) : ''
  const activate = (chip: ResolvedChip): (() => void) | undefined => {
    if (chip.core === 'cwd') return () => useUIStore.getState().showFiles()
    const ext = chip.extension
    if (!ext?.command) return undefined
    const command = ext.command
    return () => {
      void window.pine.extensions.invoke(ext.extId, command, { workspaceId, paneId })
    }
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
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => useUIStore.getState().openPromptEditor(paneId)}>
          {d.prompt.edit}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => void navigator.clipboard.writeText(promptLine(chips, separator))}
        >
          {d.prompt.copyPrompt}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!cwd}
          onClick={() => cwd && void navigator.clipboard.writeText(cwd)}
        >
          {d.prompt.copyCwd}
        </ContextMenuItem>
        <ContextMenuItem disabled={!cwd} onClick={() => useUIStore.getState().showFiles()}>
          {d.prompt.revealCwd}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
