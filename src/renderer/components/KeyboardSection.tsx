import { MagnifyingGlassIcon, MinusIcon, PlusIcon, WarningIcon } from '@phosphor-icons/react'
import {
  type ChordProblem,
  type ChordSpec,
  type ChordValue,
  DIGIT_RANGE,
  chordText,
  chordTexts,
  formatChord,
  sameChord,
  specFromEvent,
  usedByMonaco,
} from '@shared/chordSpec'
import {
  NATURAL_TEXT_EDITING,
  OSTIA_KEYMAP,
  appKeymapsFor,
  keyboardPlatform,
  terminalKeymapsFor,
} from '@shared/keyboardPresets'
import {
  TERMINAL_SEND_TYPES,
  type TerminalSend,
  type TerminalSendType,
  sendChordProblem,
  sendData,
} from '@shared/terminalKeys'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { commandWording, commands } from '../commands/registry'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import {
  WORKSPACE_GOTO,
  baseChords,
  bindableIds,
  bindingProblem,
  checkBinding,
  chordsOf,
  chordsWithout,
  conflictsWith,
  terminalKeyConflicts,
  useBindings,
  workspaceDigit,
} from '../lib/chords'
import {
  type TerminalKeyRow,
  currentTerminalKeys,
  removeTerminalKey,
  resetTerminalKey,
  saveTerminalKey,
  terminalKeyFor,
  terminalKeymapOf,
} from '../lib/keyPresets'
import { BASE_LANGUAGE } from '../lib/languagePacks'
import { isMac, platform } from '../platform'
import { useExtensionsStore } from '../stores/extensionsStore'
import { appKeymap, keymapChoices, useKeymapStore } from '../stores/keymapStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ControlRow, SectionHead, SelectField, WarningNote } from './SettingsPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'
import { Kbd } from './ui/kbd'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

const TERMINAL_TITLES: Record<string, (d: Dict) => string> = {
  copy: (d) => d.keyboard.copy,
  paste: (d) => d.keyboard.paste,
  find: (d) => d.keyboard.find,
}

function commandTitle(id: string, d: Dict): string {
  const terminal = TERMINAL_TITLES[id]
  if (terminal) return terminal(d)
  const registered = commands.list().find((c) => c.id === id)
  if (registered) return commandWording(registered, d).title
  return (d.commands.titles as Record<string, string | undefined>)[id] ?? id
}

function matchesQuery(row: { id: string; title: string; english: string }, q: string): boolean {
  const keys = chordsOf(row.id, isMac).map((spec) => chordText(spec, isMac).toLowerCase())
  return [row.title, row.english, row.id, ...keys].some((t) => t.toLowerCase().includes(q))
}

function firstIgnored(
  id: string,
  value: ChordValue,
): { value: string; problem: ChordProblem } | null {
  for (const text of chordTexts(value)) {
    const problem = checkBinding(id, text, isMac)
    if (problem) return { value: text, problem }
  }
  return null
}

function keepChords(texts: string[]): ChordValue | null {
  if (texts.length === 0) return null
  return texts.length === 1 ? texts[0] : texts
}

function sendText(send: TerminalSend): string {
  return send.type === 'escape' ? `ESC ${send.value}` : send.value
}

function matchesTerminalRow(row: TerminalKeyRow, q: string, d: Dict): boolean {
  return [
    d.keyboard.sendTitle,
    BASE_LANGUAGE.catalog.keyboard.sendTitle,
    d.keyboard.sendTypes[row.send.type],
    sendText(row.send),
    chordText(row.spec, isMac),
    row.signature,
  ].some((t) => t.toLowerCase().includes(q))
}

export function problemText(problem: ChordProblem, d: Dict, mac: boolean): string {
  const p = d.keyboard.problems
  switch (problem) {
    case 'invalid':
      return p.invalid
    case 'escape':
      return p.escape
    case 'tab':
      return p.tab
    case 'bare':
      return p.bare
    case 'needs-modifier':
      return mac ? p.needsModifierMac : p.needsModifier
    case 'ctrl-key':
      return p.ctrlKey
    case 'arrow':
      return p.arrow
    case 'digit-range':
      return p.digitRange
  }
}

export function recordedChord(id: string, spec: ChordSpec): ChordSpec {
  if (id !== WORKSPACE_GOTO || workspaceDigit(spec.key) === null) return spec
  return { ...spec, key: DIGIT_RANGE }
}

export function ChordRecorder({
  label,
  onRecord,
  onCancel,
}: {
  label: string
  onRecord: (spec: ChordSpec) => void
  onCancel: () => void
}): JSX.Element {
  const d = useDict()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      if (e.key === 'Escape' && plain) {
        onCancel()
        return
      }
      const spec = specFromEvent(e)
      if (spec) onRecord(spec)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onRecord, onCancel])
  return (
    <output aria-label={label} aria-live="polite" className="text-fg text-ui-sm">
      {d.keyboard.recording}
    </output>
  )
}

interface Pending {
  spec: ChordSpec
  conflicts: string[]
  monaco: boolean
  terminal: TerminalKeyRow | null
}

type Mode = { kind: 'idle' } | { kind: 'recording' } | ({ kind: 'pending' } & Pending)

export function KeybindingRow({ id, title }: { id: string; title: string }): JSX.Element {
  const d = useDict()
  const override = useSettingsStore((s) => (id in s.keybindings ? s.keybindings[id] : undefined))
  const setKeybinding = useSettingsStore((s) => s.setKeybinding)
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding)
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [refusal, setRefusal] = useState<string | null>(null)
  const current = chordsOf(id, isMac)
  const ignored = override ? firstIgnored(id, override) : null

  const save = (spec: ChordSpec, replace: string[], terminal: TerminalKeyRow | null): void => {
    for (const other of replace) setKeybinding(other, keepChords(chordsWithout(other, spec, isMac)))
    if (terminal) removeTerminalKey(terminal, isMac)
    const base = baseChords(id, isMac)
    if (base.length === 1 && sameChord(base[0], spec)) resetKeybinding(id)
    else setKeybinding(id, formatChord(spec, isMac))
    setMode({ kind: 'idle' })
  }

  const onRecord = (raw: ChordSpec): void => {
    const spec = recordedChord(id, raw)
    const problem = bindingProblem(id, spec, isMac)
    if (problem) {
      setRefusal(
        fmt(d.keyboard.refused, {
          keys: chordText(spec, isMac),
          reason: problemText(problem, d, isMac),
        }),
      )
      return
    }
    setRefusal(null)
    const conflicts = conflictsWith(id, spec, isMac)
    const monaco = usedByMonaco(spec, isMac)
    const terminal = terminalKeyFor(spec, isMac)
    if (conflicts.length === 0 && !monaco && !terminal) save(spec, [], null)
    else setMode({ kind: 'pending', spec, conflicts, monaco, terminal })
  }

  const cancel = (): void => {
    setRefusal(null)
    setMode({ kind: 'idle' })
  }

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="py-1.5 align-top whitespace-normal">
        <div className="text-fg text-ui-base">{title}</div>
        <div className="font-mono text-fg-muted text-ui-xs">{id}</div>
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        {mode.kind === 'recording' ? (
          <ChordRecorder
            label={fmt(d.keyboard.recordFor, { command: title })}
            onRecord={onRecord}
            onCancel={cancel}
          />
        ) : mode.kind === 'pending' ? (
          <PendingChoice
            pending={mode}
            onConfirm={() => save(mode.spec, mode.conflicts, mode.terminal)}
            onCancel={cancel}
          />
        ) : current.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {current.map((spec) => (
              <Kbd key={formatChord(spec, isMac)}>{chordText(spec, isMac)}</Kbd>
            ))}
          </span>
        ) : (
          <span className="text-fg-muted text-ui-sm">{d.keyboard.unassigned}</span>
        )}
        {refusal ? (
          <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
            {refusal}
          </p>
        ) : null}
        {ignored && mode.kind === 'idle' ? (
          <p className="mt-1 text-attn-fg text-ui-sm">
            {fmt(d.keyboard.ignored, {
              value: ignored.value,
              reason: problemText(ignored.problem, d, isMac),
            })}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5 text-right align-top">
        <div className="flex justify-end gap-1">
          <Button
            variant="outline"
            size="xs"
            aria-label={fmt(d.keyboard.recordFor, { command: title })}
            aria-pressed={mode.kind === 'recording'}
            onClick={() => {
              setRefusal(null)
              setMode(mode.kind === 'recording' ? { kind: 'idle' } : { kind: 'recording' })
            }}
          >
            {d.keyboard.record}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={fmt(d.keyboard.resetFor, { command: title })}
            disabled={override === undefined}
            onClick={() => {
              cancel()
              resetKeybinding(id)
            }}
          >
            {d.keyboard.reset}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

function PendingChoice({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: Pending
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const d = useDict()
  const keys = chordText(pending.spec, isMac)
  return (
    <div className="flex flex-col gap-1.5">
      <Kbd>{keys}</Kbd>
      {pending.conflicts.map((other) => (
        <WarningNote key={other}>
          {fmt(d.keyboard.conflict, { keys, command: commandTitle(other, d) })}
        </WarningNote>
      ))}
      {pending.terminal ? (
        <WarningNote>
          {fmt(d.keyboard.terminalConflict, { keys, send: sendText(pending.terminal.send) })}
        </WarningNote>
      ) : null}
      {pending.monaco ? <WarningNote>{fmt(d.keyboard.monaco, { keys })}</WarningNote> : null}
      <div className="flex gap-1">
        <Button size="xs" onClick={onConfirm}>
          {pending.conflicts.length > 0 || pending.terminal
            ? d.keyboard.replace
            : d.keyboard.useAnyway}
        </Button>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          {d.keyboard.cancel}
        </Button>
      </div>
    </div>
  )
}

function appKeymapLabel(id: string, d: Dict): string {
  return (d.keyboard.appKeymaps as Record<string, string | undefined>)[id] ?? id
}

function terminalKeymapLabel(id: string, d: Dict): string {
  return (d.keyboard.terminalKeymaps as Record<string, string | undefined>)[id] ?? id
}

function KeymapPickers(): JSX.Element {
  const d = useDict()
  const setKeymap = useSettingsStore((s) => s.setKeymap)
  const setTerminalKeymap = useSettingsStore((s) => s.setTerminalKeymap)
  const chosenTerminal = useSettingsStore((s) => s.terminalKeymap)
  useSettingsStore((s) => s.keymap)
  const list = useExtensionsStore((s) => s.list)
  const here = keyboardPlatform(platform)
  const choices = keymapChoices(list, platform)
  const ref = appKeymap()
  const chosen = choices.find((c) => c.ref === ref)
  const loaded = useKeymapStore((s) => (chosen && s.ref === chosen.ref ? s.loaded : null))
  const error = useKeymapStore((s) => (chosen && s.ref === chosen.ref ? s.error : null))
  const terminal = terminalKeymapOf(chosenTerminal, isMac)
  const appOptions = [
    ...appKeymapsFor(here).map((k) => ({ value: k.id, label: appKeymapLabel(k.id, d) })),
    ...choices.map((c) => ({ value: c.ref, label: c.label })),
  ]
  const appValue = appOptions.some((o) => o.value === ref) ? ref : OSTIA_KEYMAP
  return (
    <div className="mb-3">
      <ControlRow label={d.keyboard.keymap} desc={d.keyboard.keymapDesc}>
        <SelectField
          label={d.keyboard.keymap}
          value={appValue}
          onChange={setKeymap}
          options={appOptions}
        />
      </ControlRow>
      {chosen && error ? (
        <WarningNote>{fmt(d.keyboard.keymapFailed, { name: chosen.label, error })}</WarningNote>
      ) : null}
      {loaded && loaded.skipped.length > 0 ? (
        <WarningNote>
          <p>{fmt(d.keyboard.keymapSkipped, { name: loaded.label })}</p>
          <ul className="mt-1 list-disc pl-4">
            {loaded.skipped.map((skip, i) => (
              <li key={`${i}:${skip.command}`}>
                {fmt(d.keyboard.keymapSkippedEntry, {
                  command: skip.command,
                  value: skip.value,
                  reason: problemText(skip.problem, d, isMac),
                })}
              </li>
            ))}
          </ul>
        </WarningNote>
      ) : null}
      <ControlRow label={d.keyboard.terminalKeymap} desc={d.keyboard.terminalKeymapDesc}>
        <SelectField
          label={d.keyboard.terminalKeymap}
          value={terminal}
          onChange={setTerminalKeymap}
          options={terminalKeymapsFor(here).map((k) => ({
            value: k.id,
            label: terminalKeymapLabel(k.id, d),
          }))}
        />
      </ControlRow>
      {terminal === NATURAL_TEXT_EDITING ? (
        <WarningNote>{d.keyboard.naturalTextEditingNote}</WarningNote>
      ) : null}
    </div>
  )
}

interface Replacing {
  commands: string[]
  existing: TerminalKeyRow | null
}

function TerminalKeyEditor({
  previous,
  onDone,
}: {
  previous: TerminalKeyRow | null
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  const setKeybinding = useSettingsStore((s) => s.setKeybinding)
  const [spec, setSpec] = useState<ChordSpec | null>(previous?.spec ?? null)
  const [type, setType] = useState<TerminalSendType>(previous?.send.type ?? 'text')
  const [value, setValue] = useState(previous?.send.value ?? '')
  const [recording, setRecording] = useState(previous === null)
  const [problem, setProblem] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<Replacing | null>(null)
  const keys = spec ? chordText(spec, isMac) : ''

  const onRecord = (raw: ChordSpec): void => {
    const refused = sendChordProblem(raw)
    if (refused) {
      setProblem(
        fmt(d.keyboard.refused, {
          keys: chordText(raw, isMac),
          reason: problemText(refused, d, isMac),
        }),
      )
      return
    }
    setProblem(null)
    setReplacing(null)
    setSpec(raw)
    setRecording(false)
  }

  const save = (): void => {
    const send: TerminalSend = { type, value }
    if (!spec) {
      setProblem(d.keyboard.needsShortcut)
      return
    }
    if (sendData(send) === null) {
      setProblem(d.keyboard.badSend[type])
      return
    }
    setProblem(null)
    const commandsUsing = terminalKeyConflicts(spec, isMac)
    const found = terminalKeyFor(spec, isMac)
    const existing = found && found.signature !== previous?.signature ? found : null
    if (!replacing && (commandsUsing.length > 0 || existing)) {
      setReplacing({ commands: commandsUsing, existing })
      return
    }
    for (const other of commandsUsing) {
      setKeybinding(other, keepChords(chordsWithout(other, spec, isMac)))
    }
    saveTerminalKey(spec, send, previous, isMac)
    onDone()
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <SelectField
          label={d.keyboard.sendType}
          value={type}
          onChange={(v) => {
            setType(v)
            setReplacing(null)
          }}
          options={TERMINAL_SEND_TYPES.map((t) => ({ value: t, label: d.keyboard.sendTypes[t] }))}
          width="w-fit min-w-36"
        />
        <Input
          value={value}
          aria-label={d.keyboard.sendValue}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value)
            setReplacing(null)
          }}
          className="h-7 w-56 font-mono text-ui-sm"
        />
        {recording ? (
          <ChordRecorder
            label={d.keyboard.recordTerminalKey}
            onRecord={onRecord}
            onCancel={() => {
              setProblem(null)
              setRecording(false)
            }}
          />
        ) : spec ? (
          <Kbd>{keys}</Kbd>
        ) : null}
        <Button
          variant="outline"
          size="xs"
          aria-label={d.keyboard.recordTerminalKey}
          aria-pressed={recording}
          onClick={() => {
            setProblem(null)
            setRecording(!recording)
          }}
        >
          {d.keyboard.record}
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-attn-fg text-ui-sm">
          {problem}
        </p>
      ) : null}
      {replacing?.commands.map((id) => (
        <WarningNote key={id}>
          {fmt(d.keyboard.conflict, { keys, command: commandTitle(id, d) })}
        </WarningNote>
      ))}
      {replacing?.existing ? (
        <WarningNote>
          {fmt(d.keyboard.sendConflict, { keys, send: sendText(replacing.existing.send) })}
        </WarningNote>
      ) : null}
      <div className="flex gap-1">
        <Button size="xs" onClick={save}>
          {replacing ? d.keyboard.replace : d.keyboard.save}
        </Button>
        <Button variant="ghost" size="xs" onClick={onDone}>
          {d.keyboard.cancel}
        </Button>
      </div>
    </div>
  )
}

function TerminalKeyLine({ row }: { row: TerminalKeyRow }): JSX.Element {
  const d = useDict()
  const [editing, setEditing] = useState(false)
  const keys = chordText(row.spec, isMac)
  const shadowedBy = terminalKeyConflicts(row.spec, isMac)[0]
  if (editing) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={3} className="py-1.5 whitespace-normal">
          <TerminalKeyEditor previous={row} onDone={() => setEditing(false)} />
        </TableCell>
      </TableRow>
    )
  }
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="py-1.5 align-top whitespace-normal">
        <div className="text-fg text-ui-base">{d.keyboard.sendTitle}</div>
        <div className="flex flex-wrap gap-1.5 text-fg-muted text-ui-xs">
          <span>{d.keyboard.sendTypes[row.send.type]}</span>
          <span className="font-mono">{sendText(row.send)}</span>
          <span>{row.userKey ? d.keyboard.custom : d.keyboard.fromPreset}</span>
        </div>
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        <Kbd>{keys}</Kbd>
        {shadowedBy ? (
          <p className="mt-1 flex items-center gap-1 text-ui-xs text-warn-fg">
            <WarningIcon aria-hidden className="shrink-0" />
            {fmt(d.keyboard.shadowed, { command: commandTitle(shadowedBy, d) })}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5 text-right align-top">
        <div className="flex justify-end gap-1">
          <Button
            variant="outline"
            size="xs"
            aria-label={fmt(d.keyboard.editFor, { keys })}
            onClick={() => setEditing(true)}
          >
            {d.keyboard.edit}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={fmt(d.keyboard.resetFor, { command: keys })}
            disabled={!row.preset || !row.userKey}
            onClick={() => resetTerminalKey(row, isMac)}
          >
            {d.keyboard.reset}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={fmt(d.keyboard.removeFor, { keys })}
            onClick={() => removeTerminalKey(row, isMac)}
          >
            <MinusIcon />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

export function KeyboardSection(): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const keybindings = useSettingsStore((s) => s.keybindings)
  const terminalKeys = useSettingsStore((s) => s.terminalKeys)
  const setKeybindings = useSettingsStore((s) => s.setKeybindings)
  const setTerminalKeys = useSettingsStore((s) => s.setTerminalKeys)
  useSettingsStore((s) => s.terminalKeymap)
  useBindings()
  useSyncExternalStore(subscribeCommands, commandsVersion)

  const rows = bindableIds()
    .map((id) => ({
      id,
      title: commandTitle(id, d),
      english: commandTitle(id, BASE_LANGUAGE.catalog),
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
  const sends = currentTerminalKeys(isMac).rows

  const q = query.trim().toLowerCase()
  const visible = q ? rows.filter((r) => matchesQuery(r, q)) : rows
  const visibleSends = q ? sends.filter((r) => matchesTerminalRow(r, q, d)) : sends
  const untouched = Object.keys(keybindings).length === 0 && Object.keys(terminalKeys).length === 0

  return (
    <section aria-label={d.keyboard.title}>
      <SectionHead title={d.keyboard.title} desc={d.keyboard.desc} />
      <KeymapPickers />
      <div className="mb-2 flex items-center gap-2">
        <InputGroup className="h-7 flex-1">
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={d.keyboard.search}
            aria-label={d.keyboard.search}
          />
        </InputGroup>
        <Button
          variant="outline"
          size="sm"
          disabled={untouched}
          onClick={() => {
            setKeybindings({})
            setTerminalKeys({})
          }}
        >
          {d.keyboard.resetAll}
        </Button>
      </div>
      {visible.length === 0 && visibleSends.length === 0 && !adding ? (
        <p className="py-2 text-fg-muted text-ui-sm">{d.keyboard.none}</p>
      ) : (
        <Table className="text-ui-base">
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              <TableHead className="h-8 text-fg-muted text-ui-sm">{d.keyboard.command}</TableHead>
              <TableHead className="h-8 text-fg-muted text-ui-sm">{d.keyboard.shortcut}</TableHead>
              <TableHead className="h-8 text-right text-fg-muted text-ui-sm">
                <span className="sr-only">{d.keyboard.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adding ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="py-1.5 whitespace-normal">
                  <TerminalKeyEditor previous={null} onDone={() => setAdding(false)} />
                </TableCell>
              </TableRow>
            ) : null}
            {visibleSends.map((r) => (
              <TerminalKeyLine key={r.signature} row={r} />
            ))}
            {visible.map((r) => (
              <KeybindingRow key={r.id} id={r.id} title={r.title} />
            ))}
          </TableBody>
        </Table>
      )}
      <div className="mt-2 flex">
        <Button variant="outline" size="sm" disabled={adding} onClick={() => setAdding(true)}>
          <PlusIcon />
          {d.keyboard.addTerminalKey}
        </Button>
      </div>
    </section>
  )
}
