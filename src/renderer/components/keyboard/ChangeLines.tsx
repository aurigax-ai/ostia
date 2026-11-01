import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import { chordText } from '@shared/keyboard/chordSpec'
import type { JSX, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { TableCell, TableRow } from '@/components/ui/table'
import { fmt, useDict } from '@/lib/app/useDict'
import { baseChords, chordsOf, keymapBindings } from '@/lib/keyboard/chords'
import { type CommandChange, presetSendFor, type TerminalChange } from '@/lib/keyboard/keyChanges'
import { layerOf } from '@/lib/keyboard/keySources'
import type { TerminalSend } from '@/lib/keyboard/terminalKeys'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { commandTitle, keysLabel, sendLabel, sendText } from './keyboardLabels'

export function chordList(texts: readonly string[], none: string): ReactNode {
  if (texts.length === 0) return <span className="text-fg-muted text-ui-sm">{none}</span>
  return (
    <span className="flex flex-wrap items-center gap-1">
      {texts.map((t) => (
        <Kbd key={t} className="text-fg">
          {t}
        </Kbd>
      ))}
    </span>
  )
}

function RevertButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  const d = useDict()
  return (
    <Button
      variant="ghost"
      size="xs"
      className="text-fg-muted"
      aria-label={label}
      onClick={onClick}
    >
      <ArrowCounterClockwiseIcon />
      {d.keyboard.revert}
    </Button>
  )
}

export function CommandLine({
  change,
  presetName,
  custom,
}: {
  change: CommandChange
  presetName: string | null
  custom: boolean
}): JSX.Element {
  const d = useDict()
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding)
  const title = commandTitle(change.id, d)
  const now = chordsOf(change.id, isMac).map((spec) => chordText(spec, isMac))
  const base = baseChords(change.id, isMac).map((spec) => chordText(spec, isMac))
  const baseText = base.length > 0 ? base.join(' ') : d.keyboard.unassigned
  const fromPreset = presetName && layerOf(keymapBindings(), change.id, isMac) !== null
  return (
    <TableRow data-change={custom ? 'custom' : 'removed'} className="hover:bg-surface-2">
      <TableCell className="relative py-1.5 pl-3 align-top whitespace-normal">
        {custom ? (
          <span
            aria-hidden
            data-slot="custom-bar"
            className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand"
          />
        ) : null}
        <div className="truncate text-fg text-ui-base">{title}</div>
        <div className="truncate font-mono text-fg-muted text-ui-xs">{change.id}</div>
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        {chordList(custom ? now : [], d.keyboard.unassigned)}
        <div className="text-fg-muted text-ui-xs">
          {fromPreset
            ? fmt(d.keyboard.wasFrom, { keys: baseText, name: presetName })
            : fmt(d.keyboard.was, { keys: baseText })}
        </div>
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        <RevertButton
          label={fmt(d.keyboard.revertFor, { command: title })}
          onClick={() => resetKeybinding(change.id)}
        />
      </TableCell>
    </TableRow>
  )
}

export function TerminalLine({
  change,
  terminalKeymap,
  presetName,
}: {
  change: TerminalChange
  terminalKeymap: string | null
  presetName: string | null
}): JSX.Element {
  const d = useDict()
  const resetTerminalKey = useSettingsStore((s) => s.resetTerminalKey)
  const keys = keysLabel(change.keys, isMac)
  const was = presetSendFor(change.keys, terminalKeymap, isMac)
  const shown: TerminalSend | null = change.send ?? was
  const wasText = was ? sendLabel(was, d) : d.keyboard.notTranslated
  return (
    <TableRow data-change={change.send ? 'custom' : 'removed'} className="hover:bg-surface-2">
      <TableCell className="relative py-1.5 pl-3 align-top whitespace-normal">
        {change.send ? (
          <span
            aria-hidden
            data-slot="custom-bar"
            className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand"
          />
        ) : null}
        <div className="truncate text-fg text-ui-base">{shown ? sendLabel(shown, d) : keys}</div>
        {change.send ? (
          <div className="truncate font-mono text-fg-muted text-ui-xs">{sendText(change.send)}</div>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        <span className="flex flex-wrap items-center gap-1">
          <Kbd className="text-fg">{keys}</Kbd>
          {change.send ? null : (
            <span className="text-fg-muted text-ui-sm">{d.keyboard.notTranslated}</span>
          )}
        </span>
        <div className="text-fg-muted text-ui-xs">
          {was && presetName
            ? fmt(d.keyboard.wasFrom, { keys: wasText, name: presetName })
            : fmt(d.keyboard.was, { keys: wasText })}
        </div>
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        <RevertButton
          label={fmt(d.keyboard.revertFor, { command: keys })}
          onClick={() => resetTerminalKey(change.keys)}
        />
      </TableCell>
    </TableRow>
  )
}

export function PresetLine({
  title,
  sub,
  after,
  ostia,
}: {
  title: string
  sub: string | null
  after: ReactNode
  ostia: string
}): JSX.Element {
  return (
    <TableRow data-change="preset" className="hover:bg-surface-2">
      <TableCell className="py-1.5 pl-3 align-top whitespace-normal">
        <div className="truncate text-fg text-ui-base">{title}</div>
        {sub ? <div className="truncate font-mono text-fg-muted text-ui-xs">{sub}</div> : null}
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">{after}</TableCell>
      <TableCell className="py-1.5 align-top text-fg-muted text-ui-xs whitespace-normal">
        {ostia}
      </TableCell>
    </TableRow>
  )
}
