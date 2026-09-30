import { fmt, useDict } from '../i18n/useDict'
import { type ShownPaneChip, paneChipAction, usePaneChips } from '../lib/paneChips'
import { Hint } from './Hint'
import { Badge } from './ui/badge'

export function PaneChips({ paneId }: { paneId: string }): JSX.Element | null {
  const d = useDict()
  const chips = usePaneChips(paneId)
  if (chips.length === 0) return null
  return (
    <ul className="pane-chips" aria-label={d.extensions.chipsLabel}>
      {chips.map((chip) => (
        <li key={`${chip.extId}:${chip.id}`}>
          <Chip chip={chip} />
        </li>
      ))}
    </ul>
  )
}

function Chip({ chip }: { chip: ShownPaneChip }): JSX.Element {
  const d = useDict()
  const action = paneChipAction(chip)
  const hint = chip.tooltip ?? `${chip.extName} · ${chip.title}`
  const className = `pane-chip tone-${chip.tone}`
  if (!action) {
    return (
      <Hint label={hint} side="bottom">
        <Badge variant="outline" className={className}>
          {chip.text}
        </Badge>
      </Hint>
    )
  }
  return (
    <Hint label={hint} side="bottom">
      <Badge
        variant="outline"
        className={`${className} pane-chip-action`}
        render={
          <button
            type="button"
            aria-label={
              chip.url
                ? fmt(d.extensions.chipLink, { title: chip.title, text: chip.text, url: chip.url })
                : fmt(d.extensions.chipAction, {
                    title: chip.title,
                    text: chip.text,
                    command: chip.command ?? '',
                  })
            }
            onClick={() => void action()}
          />
        }
      >
        {chip.text}
      </Badge>
    </Hint>
  )
}
