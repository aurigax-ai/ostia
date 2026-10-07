import { chordText } from '@shared/chordSpec'
import { useDict } from '../i18n/useDict'
import type { LinkKind } from '../lib/linkModifier'
import { isMac } from '../platform'
import { useSettingsStore } from '../stores/settingsStore'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export interface LinkHintBox {
  kind: LinkKind
  left: number
  top: number
  width: number
  height: number
}

export function TerminalLinkHint({ hint }: { hint: LinkHintBox | null }): JSX.Element | null {
  const d = useDict()
  const opensInPane = useSettingsStore((s) => s.browser.openTerminalLinks)
  if (!hint) return null
  const click = (shift: boolean): string =>
    chordText({ ctrl: !isMac, meta: isMac, shift, alt: false, key: d.terminalLinks.click }, isMac)
  const rows: [string, string][] =
    hint.kind === 'file'
      ? [[click(false), d.terminalLinks.openFile]]
      : [
          [click(false), opensInPane ? d.terminalLinks.openPane : d.terminalLinks.openSystem],
          [click(true), opensInPane ? d.terminalLinks.openSystem : d.terminalLinks.openPane],
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
