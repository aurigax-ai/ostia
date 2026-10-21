import type { Dict } from '@shared/app/dict'
import { linkKind } from '@shared/common/externalLinks'
import { chordText } from '@shared/keyboard/chordSpec'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDict } from '@/lib/app/useDict'
import {
  type LinkKind,
  type PathLinkTarget,
  pathLinkTarget,
  webLinkTarget,
} from '@/lib/terminalLinks/linkModifier'
import type { FileLinkAction } from '@/lib/terminalLinks/terminalFileLinks'
import type { FileUrlAction } from '@/lib/terminalLinks/terminalFileUrls'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'

type PathHintKind = FileLinkAction | FileUrlAction

const FILE_ACTION_TEXT: Record<PathHintKind, (d: Dict) => string> = {
  'open-file': (d) => d.terminalLinks.openFile,
  'admit-file': (d) => d.terminalLinks.openFile,
  'reveal-folder': (d) => d.terminalLinks.revealFolder,
  'open-folder': (d) => d.terminalLinks.openFolder,
  'preview-page': (d) => d.terminalLinks.openFile,
  'browse-page': (d) => d.terminalLinks.openSystem,
  'open-default': (d) => d.terminalLinks.openDefault,
}

const FOLDER_ACTIONS: ReadonlySet<PathHintKind> = new Set(['reveal-folder', 'open-folder'])

const PATH_CLICKS = [
  { shift: false, alt: false },
  { shift: true, alt: false },
  { shift: false, alt: true },
  { shift: true, alt: true },
] as const

function pathTargetText(d: Dict, action: PathHintKind, how: PathLinkTarget): string {
  if (how === 'open') return FILE_ACTION_TEXT[action](d)
  if (how === 'show') return d.terminalLinks.showInFiles
  if (how === 'show-system') return d.terminalLinks.showInFileManager
  if (action === 'preview-page') return d.terminalLinks.openSystem
  return FOLDER_ACTIONS.has(action) ? d.terminalLinks.openFolder : d.terminalLinks.openDefault
}

export interface LinkHintBox {
  kind: LinkKind
  url?: string
  offers?: PathLinkTarget[]
  plainClick: boolean
  left: number
  top: number
  width: number
  height: number
}

export function TerminalLinkHint({ hint }: { hint: LinkHintBox | null }): JSX.Element | null {
  const d = useDict()
  const linkClick = useSettingsStore((s) => s.terminal.linkClick)
  if (!hint) return null
  const click = (shift: boolean, alt = false): string =>
    chordText({ ctrl: !isMac, meta: isMac, shift, alt, key: d.terminalLinks.click }, isMac)
  const opens = (shift: boolean): string =>
    webLinkTarget(
      { ctrlKey: !isMac, metaKey: isMac, shiftKey: shift, detail: 1 },
      { mac: isMac, hasSelection: false, mouseReporting: false, linkClick },
    ) === 'system'
      ? d.terminalLinks.openSystem
      : d.terminalLinks.openNewTab
  const pathRows = (action: PathHintKind, offers: PathLinkTarget[]): [string, string][] =>
    PATH_CLICKS.flatMap(({ shift, alt }) => {
      const how = pathLinkTarget(
        { ctrlKey: !isMac, metaKey: isMac, shiftKey: shift, altKey: alt },
        { mac: isMac, linkClick },
      )
      return how && offers.includes(how)
        ? [[click(shift, alt), pathTargetText(d, action, how)] as [string, string]]
        : []
    })
  const rows: [string, string][] =
    hint.kind !== 'web'
      ? pathRows(hint.kind, hint.offers ?? ['open'])
      : hint.url && linkKind(hint.url) === 'external'
        ? [[hint.plainClick ? d.terminalLinks.click : click(false), d.terminalLinks.openApp]]
        : [
            ...(hint.plainClick
              ? [[d.terminalLinks.click, d.terminalLinks.openPane] as [string, string]]
              : []),
            [click(false), opens(false)],
            [click(true), opens(true)],
          ]
  const { left, top, width, height } = hint
  return (
    <Tooltip key={`${left},${top},${width}`} open>
      <TooltipTrigger
        render={
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={{ left, top, width, height }}
          />
        }
      />
      <TooltipContent side="top">
        <span className="flex flex-col gap-0.5">
          {hint.url && <span className="break-all font-mono">{hint.url}</span>}
          {rows.map(([chord, action]) => (
            <span key={chord}>
              <span className="font-medium">{chord}</span> {action}
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
