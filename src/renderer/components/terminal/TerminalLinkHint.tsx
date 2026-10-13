import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDict } from '@/i18n/useDict'
import type { LinkKind } from '@/lib/terminal/linkModifier'
import type { FileLinkAction } from '@/lib/terminal/terminalFileLinks'
import { isMac } from '@/platform'
import type { Dict } from '@shared/app/dict'
import { chordText } from '@shared/keyboard/chordSpec'
import { linkKind } from '@shared/links/externalLinks'

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
  if (!hint) return null
  const click = (shift: boolean): string =>
    chordText({ ctrl: !isMac, meta: isMac, shift, alt: false, key: d.terminalLinks.click }, isMac)
  const rows: [string, string][] =
    hint.kind !== 'web'
      ? [[click(false), FILE_ACTION_TEXT[hint.kind](d)]]
      : hint.url && linkKind(hint.url) === 'external'
        ? [[hint.plainClick ? d.terminalLinks.click : click(false), d.terminalLinks.openApp]]
        : [
            ...(hint.plainClick
              ? [[d.terminalLinks.click, d.terminalLinks.openPane] as [string, string]]
              : []),
            [click(false), d.terminalLinks.openNewTab],
            [click(true), d.terminalLinks.openSystem],
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
