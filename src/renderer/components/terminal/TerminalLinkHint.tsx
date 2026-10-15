import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDict } from '@/lib/app/useDict'
import { type LinkKind, webLinkTarget } from '@/lib/terminalLinks/linkModifier'
import type { FileLinkAction } from '@/lib/terminalLinks/terminalFileLinks'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { Dict } from '@shared/app/dict'
import { linkKind } from '@shared/common/externalLinks'
import { chordText } from '@shared/keyboard/chordSpec'

const FILE_ACTION_TEXT: Record<FileLinkAction, (d: Dict) => string> = {
  'open-file': (d) => d.terminalLinks.openFile,
  'admit-file': (d) => d.terminalLinks.openFile,
  'reveal-folder': (d) => d.terminalLinks.revealFolder,
  'open-folder': (d) => d.terminalLinks.openFolder,
}

export interface LinkHintBox {
  kind: LinkKind
  url?: string
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
  const click = (shift: boolean): string =>
    chordText({ ctrl: !isMac, meta: isMac, shift, alt: false, key: d.terminalLinks.click }, isMac)
  const opens = (shift: boolean): string =>
    webLinkTarget(
      { ctrlKey: !isMac, metaKey: isMac, shiftKey: shift, detail: 1 },
      { mac: isMac, hasSelection: false, mouseReporting: false, linkClick },
    ) === 'system'
      ? d.terminalLinks.openSystem
      : d.terminalLinks.openNewTab
  const rows: [string, string][] =
    hint.kind !== 'web'
      ? [[click(false), FILE_ACTION_TEXT[hint.kind](d)]]
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
