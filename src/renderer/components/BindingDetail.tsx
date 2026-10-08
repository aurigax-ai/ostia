import { ArrowLeftIcon } from '@phosphor-icons/react'
import { type ChordSpec, chordText } from '@shared/chordSpec'
import type { TerminalSend } from '@shared/terminalKeys'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import type { CommandSources, KeySource, Layer, TerminalKeySources } from '../lib/keySources'
import { isMac } from '../platform'
import { sendLabel } from './keyboardLabels'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import { TableCell, TableRow } from './ui/table'

export const ROW_TOGGLE = 'row-toggle'

export function moveRowFocus(from: HTMLElement, step: 1 | -1): boolean {
  const scope = from.closest('table')
  if (!scope) return false
  const toggles = [...scope.querySelectorAll<HTMLElement>(`[data-slot="${ROW_TOGGLE}"]`)]
  const next = toggles[toggles.indexOf(from) + step]
  if (!next) return false
  next.focus()
  return true
}

export function onToggleKey(
  e: ReactKeyboardEvent<HTMLElement>,
  expanded: boolean,
  collapse: () => void,
): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (moveRowFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault()
    return
  }
  if (e.key === 'Escape' && expanded) {
    e.preventDefault()
    e.stopPropagation()
    collapse()
  }
}

export function RowToggle({
  label,
  expanded,
  controls,
  onToggle,
  onCollapse,
  toggleRef,
  children,
}: {
  label: string
  expanded: boolean
  controls: string
  onToggle: () => void
  onCollapse: () => void
  toggleRef: React.Ref<HTMLButtonElement>
  children: ReactNode
}): JSX.Element {
  return (
    <button
      ref={toggleRef}
      type="button"
      data-slot={ROW_TOGGLE}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      onClick={onToggle}
      onKeyDown={(e) => onToggleKey(e, expanded, onCollapse)}
      className="block w-full min-w-0 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-brand"
    >
      {children}
    </button>
  )
}

interface LayerLine {
  source: KeySource
  name: string
  value: ReactNode
}

function chords(specs: readonly ChordSpec[]): ReactNode {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {specs.map((spec) => (
        <Kbd key={chordText(spec, isMac) + String(spec.terminal)} className="text-fg">
          {chordText(spec, isMac)}
        </Kbd>
      ))}
    </span>
  )
}

function DetailFrame({
  id,
  label,
  active,
  lines,
  effective,
  actions,
  onCollapse,
}: {
  id: string
  label: string
  active: ReactNode
  lines: LayerLine[]
  effective: KeySource
  actions: ReactNode
  onCollapse: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <TableRow className="hover:bg-transparent" data-slot="binding-detail">
      <TableCell colSpan={3} className="py-1.5 pl-6 whitespace-normal">
        <section
          id={id}
          aria-label={label}
          className="key-reveal rounded-md border border-line bg-surface-1 p-2"
          onKeyDownCapture={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            onCollapse()
          }}
        >
          <div className="grid grid-cols-[7rem_1fr] items-start gap-x-3 gap-y-1 text-ui-sm">
            <span className="pt-0.5 text-fg-muted">{d.keyboard.active}</span>
            <div className="relative">{active}</div>
            <span className="pt-0.5 text-fg-muted">{d.keyboard.layers}</span>
            <ul aria-label={d.keyboard.layers} className="flex flex-col gap-0.5">
              {lines.map((line) => {
                const on = line.source === effective
                return (
                  <li
                    key={line.source}
                    data-layer={line.source}
                    data-effective={on || undefined}
                    className="grid grid-cols-[8rem_1fr_auto] items-center gap-2"
                  >
                    <span className={on ? 'text-fg' : 'text-fg-muted'}>{line.name}</span>
                    <span className={on ? 'text-fg' : 'text-fg-muted'}>{line.value}</span>
                    <span className="flex items-center gap-1 text-fg-muted text-ui-xs">
                      {on ? (
                        <>
                          <ArrowLeftIcon className="size-3 shrink-0" aria-hidden />
                          {d.keyboard.inEffect}
                        </>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">{actions}</div>
        </section>
      </TableCell>
    </TableRow>
  )
}

function layerValue(layer: Layer, d: ReturnType<typeof useDict>): ReactNode {
  if (layer === null) return d.keyboard.notSet
  if (layer === 'unbound' || layer.length === 0) return d.keyboard.noKeys
  return chords(layer)
}

export function BindingDetail({
  id,
  title,
  sources,
  presetName,
  active,
  onBack,
  onUnbind,
  onCollapse,
}: {
  id: string
  title: string
  sources: CommandSources
  presetName: string | null
  active: ReactNode
  onBack: () => void
  onUnbind: () => void
  onCollapse: () => void
}): JSX.Element {
  const d = useDict()
  const ostiaName = d.keyboard.appKeymaps.ostia
  const lines: LayerLine[] = [
    { source: 'user', name: d.keyboard.layerYours, value: layerValue(sources.user, d) },
  ]
  if (presetName) {
    lines.push({ source: 'preset', name: presetName, value: layerValue(sources.preset, d) })
  }
  lines.push({
    source: 'default',
    name: ostiaName,
    value: sources.ostia.length > 0 ? chords(sources.ostia) : d.keyboard.unassigned,
  })
  const backName = presetName && sources.preset !== null ? presetName : ostiaName
  return (
    <DetailFrame
      id={id}
      label={fmt(d.keyboard.detailsFor, { command: title })}
      active={active}
      lines={lines}
      effective={sources.source}
      onCollapse={onCollapse}
      actions={
        <>
          {sources.user !== null ? (
            <Button variant="outline" size="xs" onClick={onBack}>
              {fmt(d.keyboard.backTo, { name: backName })}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="xs"
            disabled={sources.effective.length === 0}
            onClick={onUnbind}
          >
            {d.keyboard.bindNone}
          </Button>
        </>
      }
    />
  )
}

function sendValue(send: TerminalSend | null, d: ReturnType<typeof useDict>): ReactNode {
  return send ? sendLabel(send, d) : d.keyboard.notSet
}

export function TerminalKeyDetail({
  id,
  keys,
  entry,
  presetName,
  active,
  onBack,
  onUnbind,
  onCollapse,
}: {
  id: string
  keys: string
  entry: TerminalKeySources
  presetName: string | null
  active: ReactNode
  onBack: () => void
  onUnbind: () => void
  onCollapse: () => void
}): JSX.Element {
  const d = useDict()
  const ostiaName = d.keyboard.terminalKeymaps.ostia
  const { row } = entry
  const lines: LayerLine[] = [
    {
      source: 'user',
      name: d.keyboard.layerYours,
      value: row.userKey ? sendValue(row.send, d) : d.keyboard.notSet,
    },
  ]
  if (presetName)
    lines.push({ source: 'preset', name: presetName, value: sendValue(row.preset, d) })
  lines.push({ source: 'default', name: ostiaName, value: sendValue(entry.ostia, d) })
  const backName = presetName && row.preset ? presetName : ostiaName
  return (
    <DetailFrame
      id={id}
      label={fmt(d.keyboard.detailsFor, { command: keys })}
      active={active}
      lines={lines}
      effective={entry.source}
      onCollapse={onCollapse}
      actions={
        <>
          {row.userKey && row.preset ? (
            <Button variant="outline" size="xs" onClick={onBack}>
              {fmt(d.keyboard.backTo, { name: backName })}
            </Button>
          ) : null}
          <Button variant="outline" size="xs" onClick={onUnbind}>
            {d.keyboard.bindNone}
          </Button>
        </>
      }
    />
  )
}
