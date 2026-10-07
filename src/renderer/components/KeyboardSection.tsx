import {
  ArrowCounterClockwiseIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  type ChordProblem,
  type ChordSpec,
  type ChordValue,
  DIGIT_RANGE,
  chordText,
  chordTexts,
  formatScopedChord,
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
import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'
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
  chordsWithoutKey,
  conflictsWith,
  keymapBindings,
  terminalKeyConflicts,
  useBindings,
  workspaceDigit,
} from '../lib/chords'
import {
  type TerminalKeyRow,
  removeTerminalKey,
  resetTerminalKey,
  saveTerminalKey,
  terminalKeyFor,
  terminalKeymapOf,
} from '../lib/keyPresets'
import {
  type KeySource,
  type TerminalKeySources,
  canAddChord,
  commandGroup,
  commandSources,
  groupRows,
  overrideFor,
  terminalKeySources,
  withChordAdded,
  withChordRemoved,
  withChordReplaced,
} from '../lib/keySources'
import { BASE_LANGUAGE } from '../lib/languagePacks'
import { sendActionKey } from '../lib/presetDiff'
import { isMac, platform } from '../platform'
import { useExtensionsStore } from '../stores/extensionsStore'
import { appKeymap, keymapChoices, useKeymapStore } from '../stores/keymapStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ControlRow, SectionHead, SelectField, WarningNote } from './SettingsPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'
import { Kbd } from './ui/kbd'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

const TERMINAL_TITLES: Record<string, (d: Dict) => string> = {
  copy: (d) => d.keyboard.copy,
  paste: (d) => d.keyboard.paste,
  find: (d) => d.keyboard.find,
  'find.next': (d) => d.keyboard.findNext,
  'find.previous': (d) => d.keyboard.findPrevious,
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
  const action = sendActionKey(row.send)
  const actions = action
    ? [d.keyboard.sendActions[action], BASE_LANGUAGE.catalog.keyboard.sendActions[action]]
    : []
  return [
    ...actions,
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

type Target = number | null

type Mode =
  | { kind: 'idle' }
  | { kind: 'recording'; target: Target }
  | ({ kind: 'pending'; target: Target } & Pending)

function SourceLabel({
  label,
  presetName,
}: {
  label: KeySource | null
  presetName: string | null
}): JSX.Element | null {
  const d = useDict()
  if (label === 'user') {
    return <span className="text-brand text-ui-xs">{d.keyboard.custom}</span>
  }
  if (label === 'preset' && presetName) {
    return <span className="text-fg-muted text-ui-xs">{presetName}</span>
  }
  return null
}

function CustomBar({ on }: { on: boolean }): JSX.Element | null {
  if (!on) return null
  return (
    <span
      aria-hidden
      data-slot="custom-bar"
      className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand"
    />
  )
}

function KeyNotice({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      data-slot="key-notice"
      className="absolute top-full left-0 z-20 mt-0.5 w-max max-w-md rounded-md border border-line bg-popover p-2 text-popover-foreground shadow-md"
    >
      {children}
    </div>
  )
}

function RecordingChip({
  label,
  onRecord,
  onCancel,
}: {
  label: string
  onRecord: (spec: ChordSpec) => void
  onCancel: () => void
}): JSX.Element {
  return (
    <span className="inline-flex h-5 items-center rounded-sm px-1 ring-1 ring-brand">
      <ChordRecorder label={label} onRecord={onRecord} onCancel={onCancel} />
    </span>
  )
}

export function KeybindingRow({
  id,
  title,
  presetName,
}: {
  id: string
  title: string
  presetName: string | null
}): JSX.Element {
  const d = useDict()
  const user = useSettingsStore((s) => s.keybindings)
  const override = id in user ? user[id] : undefined
  const setKeybinding = useSettingsStore((s) => s.setKeybinding)
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding)
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [refusal, setRefusal] = useState<string | null>(null)
  const current = chordsOf(id, isMac)
  const sources = commandSources(id, user, keymapBindings(), isMac)
  const ignored = override ? firstIgnored(id, override) : null

  const apply = (next: string[]): void => {
    const result = overrideFor(next, baseChords(id, isMac), isMac)
    if (result.reset) resetKeybinding(id)
    else setKeybinding(id, result.value)
  }

  const save = (
    spec: ChordSpec,
    target: Target,
    replace: string[],
    terminal: TerminalKeyRow | null,
  ): void => {
    for (const other of replace) setKeybinding(other, keepChords(chordsWithout(other, spec, isMac)))
    if (terminal) removeTerminalKey(terminal, isMac)
    apply(
      target === null
        ? withChordAdded(current, spec, isMac)
        : withChordReplaced(current, target, spec, isMac),
    )
    setMode({ kind: 'idle' })
  }

  const onRecord = (raw: ChordSpec): void => {
    if (mode.kind !== 'recording') return
    const target = mode.target
    const recorded = recordedChord(id, raw)
    const scoped = target === null ? recorded : { ...recorded, terminal: current[target]?.terminal }
    const problem = bindingProblem(id, scoped, isMac)
    if (problem) {
      setRefusal(
        fmt(d.keyboard.refused, {
          keys: chordText(scoped, isMac),
          reason: problemText(problem, d, isMac),
        }),
      )
      return
    }
    setRefusal(null)
    const conflicts = conflictsWith(id, scoped, isMac)
    const monaco = usedByMonaco(scoped, isMac)
    const terminal = terminalKeyFor(scoped, isMac)
    if (conflicts.length === 0 && !monaco && !terminal) save(scoped, target, [], null)
    else setMode({ kind: 'pending', target, spec: scoped, conflicts, monaco, terminal })
  }

  const cancel = (): void => {
    setRefusal(null)
    setMode({ kind: 'idle' })
  }

  const startRecording = (target: Target): void => {
    setRefusal(null)
    const same = mode.kind === 'recording' && mode.target === target
    setMode(same ? { kind: 'idle' } : { kind: 'recording', target })
  }

  const recordingAt = (target: Target): boolean =>
    mode.kind === 'recording' && mode.target === target
  const recorder = (
    <RecordingChip
      label={fmt(d.keyboard.recordFor, { command: title })}
      onRecord={onRecord}
      onCancel={cancel}
    />
  )

  return (
    <TableRow data-source={sources.label ?? 'default'} className="group/row hover:bg-surface-2">
      <TableCell className="relative py-1.5 pl-3 align-top whitespace-normal">
        <CustomBar on={sources.label === 'user'} />
        <div className="truncate text-fg text-ui-base">{title}</div>
        <div className="truncate font-mono text-fg-muted text-ui-xs">{id}</div>
      </TableCell>
      <TableCell className="relative py-1.5 align-top whitespace-normal">
        <span className="flex flex-wrap items-center gap-1">
          {current.map((spec, i) => {
            const keys = chordText(spec, isMac)
            if (recordingAt(i)) return <span key={formatScopedChord(spec, isMac)}>{recorder}</span>
            return (
              <span
                key={formatScopedChord(spec, isMac)}
                className="group/chip inline-flex items-center gap-0.5"
              >
                <button
                  type="button"
                  className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-brand"
                  aria-label={fmt(d.keyboard.changeFor, { keys, command: title })}
                  onClick={() => startRecording(i)}
                >
                  <Kbd className="text-fg">{keys}</Kbd>
                </button>
                {spec.terminal ? (
                  <span className="text-fg-muted text-ui-xs">{d.keyboard.inTerminal}</span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-2xs"
                  className="text-fg-dim opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100"
                  aria-label={fmt(d.keyboard.removeChordFor, { keys, command: title })}
                  onClick={() => {
                    cancel()
                    apply(withChordRemoved(current, i, isMac))
                  }}
                >
                  <XIcon />
                </Button>
              </span>
            )
          })}
          {current.length === 0 && !recordingAt(null) ? (
            <span className="text-fg-muted text-ui-sm">{d.keyboard.unassigned}</span>
          ) : null}
          {recordingAt(null) ? recorder : null}
          {canAddChord(current) && !recordingAt(null) ? (
            <Button
              variant="ghost"
              size="icon-2xs"
              className={
                current.length === 0
                  ? 'text-fg-muted'
                  : 'text-fg-dim opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
              }
              aria-label={fmt(d.keyboard.addFor, { command: title })}
              onClick={() => startRecording(null)}
            >
              <PlusIcon />
            </Button>
          ) : null}
        </span>
        {refusal || mode.kind === 'pending' ? (
          <KeyNotice>
            {refusal ? (
              <p role="alert" className="text-attn-fg text-ui-sm">
                {refusal}
              </p>
            ) : null}
            {mode.kind === 'pending' ? (
              <PendingChoice
                pending={mode}
                onConfirm={() => save(mode.spec, mode.target, mode.conflicts, mode.terminal)}
                onCancel={cancel}
              />
            ) : null}
          </KeyNotice>
        ) : null}
        {ignored && mode.kind === 'idle' ? (
          <WarningNote>
            {fmt(d.keyboard.ignored, {
              value: ignored.value,
              reason: problemText(ignored.problem, d, isMac),
            })}
          </WarningNote>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        <div className="flex items-center gap-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <SourceLabel label={sources.label} presetName={presetName} />
            {sources.label && sources.dropped.length > 0 ? (
              <span className="text-fg-dim text-ui-xs">
                {fmt(d.keyboard.dropped, {
                  keys: sources.dropped.map((spec) => chordText(spec, isMac)).join(' '),
                })}
              </span>
            ) : null}
          </div>
          {override !== undefined ? (
            <Button
              variant="ghost"
              size="icon-2xs"
              className="text-fg-muted"
              aria-label={fmt(d.keyboard.resetFor, { command: title })}
              onClick={() => {
                cancel()
                resetKeybinding(id)
              }}
            >
              <ArrowCounterClockwiseIcon />
            </Button>
          ) : null}
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
      <Kbd className="text-fg">{keys}</Kbd>
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
      setKeybinding(other, keepChords(chordsWithoutKey(other, spec, isMac)))
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

function sendActionText(send: TerminalSend, d: Dict): string | null {
  const key = sendActionKey(send)
  return key ? d.keyboard.sendActions[key] : null
}

function TerminalKeyLine({
  entry,
  presetName,
}: {
  entry: TerminalKeySources
  presetName: string | null
}): JSX.Element {
  const d = useDict()
  const [editing, setEditing] = useState(false)
  const { row } = entry
  const keys = chordText(row.spec, isMac)
  const shadowedBy = terminalKeyConflicts(row.spec, isMac)[0]
  const action = sendActionText(row.send, d)
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
    <TableRow data-source={entry.label ?? 'default'} className="group/row hover:bg-surface-2">
      <TableCell className="relative py-1.5 pl-3 align-top whitespace-normal">
        <CustomBar on={entry.label === 'user'} />
        {action ? (
          <>
            <div className="truncate text-fg text-ui-base">{action}</div>
            <div className="truncate font-mono text-fg-muted text-ui-xs">{sendText(row.send)}</div>
          </>
        ) : (
          <>
            <div className="truncate font-mono text-fg text-ui-base">{sendText(row.send)}</div>
            <div className="truncate text-fg-muted text-ui-xs">
              {d.keyboard.sendTypes[row.send.type]}
            </div>
          </>
        )}
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        <span className="group/chip inline-flex items-center gap-0.5">
          <button
            type="button"
            className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-brand"
            aria-label={fmt(d.keyboard.editFor, { keys })}
            onClick={() => setEditing(true)}
          >
            <Kbd className="text-fg">{keys}</Kbd>
          </button>
          <Button
            variant="ghost"
            size="icon-2xs"
            className="text-fg-dim opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100"
            aria-label={fmt(d.keyboard.removeFor, { keys })}
            onClick={() => removeTerminalKey(row, isMac)}
          >
            <XIcon />
          </Button>
        </span>
        {shadowedBy ? (
          <WarningNote>
            {fmt(d.keyboard.shadowed, { command: commandTitle(shadowedBy, d) })}
          </WarningNote>
        ) : null}
      </TableCell>
      <TableCell className="py-1.5 align-top whitespace-normal">
        <div className="flex items-center gap-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <SourceLabel label={entry.label} presetName={presetName} />
          </div>
          {row.preset && row.userKey ? (
            <Button
              variant="ghost"
              size="icon-2xs"
              className="text-fg-muted"
              aria-label={fmt(d.keyboard.resetFor, { command: keys })}
              onClick={() => resetTerminalKey(row, isMac)}
            >
              <ArrowCounterClockwiseIcon />
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

function GroupHead({ name }: { name: string }): JSX.Element {
  return (
    <TableRow className="border-line hover:bg-transparent">
      <TableHead
        colSpan={3}
        scope="colgroup"
        className="h-7 pt-3 pl-3 font-medium text-fg-muted text-ui-xs"
      >
        {name}
      </TableHead>
    </TableRow>
  )
}

function useKeymapNames(): { app: string | null; terminal: string | null } {
  const d = useDict()
  const chosenTerminal = useSettingsStore((s) => s.terminalKeymap)
  useSettingsStore((s) => s.keymap)
  const list = useExtensionsStore((s) => s.list)
  const loaded = useKeymapStore((s) => s.loaded)
  const ref = appKeymap()
  const chosen = keymapChoices(list, platform).find((c) => c.ref === ref)
  const terminal = terminalKeymapOf(chosenTerminal, isMac)
  return {
    app: chosen && loaded ? (loaded.label ?? chosen.label) : null,
    terminal: terminal === terminalKeymapOf(null, isMac) ? null : terminalKeymapLabel(terminal, d),
  }
}

export const KEY_TABLE_COLUMNS = ['w-[42%]', 'w-[36%]', 'w-[22%]'] as const

export function KeyboardSection(): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const keybindings = useSettingsStore((s) => s.keybindings)
  const terminalKeys = useSettingsStore((s) => s.terminalKeys)
  const terminalKeymap = useSettingsStore((s) => s.terminalKeymap)
  const setKeybindings = useSettingsStore((s) => s.setKeybindings)
  const setTerminalKeys = useSettingsStore((s) => s.setTerminalKeys)
  const names = useKeymapNames()
  useBindings()
  useSyncExternalStore(subscribeCommands, commandsVersion)

  const categories = new Map(commands.list().map((c) => [c.id, c.category]))
  const rows = bindableIds()
    .map((id) => ({
      id,
      title: commandTitle(id, d),
      english: commandTitle(id, BASE_LANGUAGE.catalog),
      group: commandGroup(id, categories.get(id)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
  const sends = terminalKeySources(terminalKeys, terminalKeymap, isMac)

  const q = query.trim().toLowerCase()
  const visible = q ? rows.filter((r) => matchesQuery(r, q)) : rows
  const visibleSends = q ? sends.filter((r) => matchesTerminalRow(r.row, q, d)) : sends
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
        <table data-slot="table" className="w-full table-fixed caption-bottom text-ui-base">
          <colgroup>
            {KEY_TABLE_COLUMNS.map((width) => (
              <col key={width} className={width} />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              <TableHead className="h-8 pl-3 text-fg-muted text-ui-sm">
                {d.keyboard.command}
              </TableHead>
              <TableHead className="h-8 text-fg-muted text-ui-sm">{d.keyboard.shortcut}</TableHead>
              <TableHead className="h-8 text-fg-muted text-ui-sm">{d.keyboard.source}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupRows(visible).map(({ group, rows: inGroup }) => (
              <Fragment key={group}>
                <GroupHead name={d.keyboard.groups[group]} />
                {inGroup.map((r) => (
                  <KeybindingRow key={r.id} id={r.id} title={r.title} presetName={names.app} />
                ))}
              </Fragment>
            ))}
            {visibleSends.length > 0 || adding ? (
              <GroupHead name={d.keyboard.groups.textEditing} />
            ) : null}
            {visibleSends.map((r) => (
              <TerminalKeyLine key={r.row.signature} entry={r} presetName={names.terminal} />
            ))}
            {adding ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="py-1.5 whitespace-normal">
                  <TerminalKeyEditor previous={null} onDone={() => setAdding(false)} />
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </table>
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
