import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { SectionHead, SelectField, WarningNote } from '@/components/settings/SettingsPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmt, useDict } from '@/i18n/useDict'
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
  holdDoubleShift,
  keymapBindings,
  terminalKeyConflicts,
  useBindings,
  workspaceDigit,
} from '@/lib/chords'
import { currentDesktops } from '@/lib/desktop'
import {
  type TerminalKeyRow,
  removeTerminalKey,
  resetTerminalKey,
  saveTerminalKey,
  terminalKeyFor,
  terminalKeymapOf,
} from '@/lib/keyPresets'
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
} from '@/lib/keySources'
import { BASE_LANGUAGE } from '@/lib/languagePacks'
import { SEND_ACTION_KEYS, type SendActionKey, actionSend, sendActionKey } from '@/lib/presetDiff'
import { isMac, platform } from '@/platform'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { appKeymap, keymapChoices, useKeymapStore } from '@/stores/keymapStore'
import { useSettingsStore } from '@/stores/settingsStore'
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
  DOUBLE_SHIFT,
  chordText,
  chordTexts,
  doubleShiftDetector,
  formatScopedChord,
  parseChord,
  specFromEvent,
  usedByMonaco,
} from '@shared/chordSpec'
import { desktopTaking } from '@shared/desktopChords'
import type { Dict } from '@shared/dict'
import {
  TERMINAL_SEND_TYPES,
  type TerminalSend,
  type TerminalSendType,
  sendChordProblem,
  sendData,
} from '@shared/terminalKeys'
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BindingDetail, RowToggle, TerminalKeyDetail } from './BindingDetail'
import { ChangesView, useChangeTotal } from './ChangesView'
import { KeymapCombo } from './KeymapCombo'
import {
  KEY_TABLE_COLUMNS,
  commandTitle,
  problemText,
  sendActionText,
  sendText,
  terminalKeymapLabel,
} from './keyboardLabels'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

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
  const [doubleShift] = useState(doubleShiftDetector)
  useEffect(() => {
    const release = holdDoubleShift()
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      doubleShift.down(e, e.timeStamp)
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      if (e.key === 'Escape' && plain) {
        onCancel()
        return
      }
      const spec = specFromEvent(e)
      if (spec) onRecord(spec)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!doubleShift.up(e, e.timeStamp)) return
      const spec = parseChord(DOUBLE_SHIFT, isMac)
      if (spec) onRecord(spec)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      release()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [onRecord, onCancel, doubleShift])
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

function DesktopNote({ specs }: { specs: readonly ChordSpec[] }): JSX.Element | null {
  const d = useDict()
  const desktops = currentDesktops()
  const taken = specs.flatMap((spec) => {
    const desktop = desktopTaking(spec, desktops)
    return desktop ? [{ desktop, keys: chordText(spec, isMac) }] : []
  })
  if (taken.length === 0) return null
  return (
    <WarningNote>
      {fmt(d.keyboard.desktopTakes, {
        desktop: taken[0].desktop,
        keys: taken.map((t) => t.keys).join(' '),
      })}
    </WarningNote>
  )
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

function ReadOnlyChords({ specs }: { specs: readonly ChordSpec[] }): JSX.Element {
  const d = useDict()
  if (specs.length === 0) {
    return <span className="text-fg-muted text-ui-sm">{d.keyboard.unassigned}</span>
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {specs.map((spec) => (
        <span key={formatScopedChord(spec, isMac)} className="inline-flex items-center gap-0.5">
          <Kbd className="text-fg">{chordText(spec, isMac)}</Kbd>
          {spec.terminal ? (
            <span className="text-fg-muted text-ui-xs">{d.keyboard.inTerminal}</span>
          ) : null}
        </span>
      ))}
    </span>
  )
}

function useCollapse(expanded: boolean, onToggle: () => void, before: () => void) {
  const toggleRef = useRef<HTMLButtonElement>(null)
  const toggle = (): void => {
    before()
    onToggle()
  }
  const collapse = (): void => {
    if (!expanded) return
    before()
    onToggle()
    toggleRef.current?.focus()
  }
  return { toggleRef, toggle, collapse }
}

export function KeybindingRow({
  id,
  title,
  presetName,
  expanded = false,
  onToggle = () => {},
}: {
  id: string
  title: string
  presetName: string | null
  expanded?: boolean
  onToggle?: () => void
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
  const detailId = `binding-detail-${id}`

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

  const { toggleRef, toggle, collapse } = useCollapse(expanded, onToggle, cancel)

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

  const editor = (
    <>
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
              <IconButton
                icon={XIcon}
                label={fmt(d.keyboard.removeChordFor, { keys, command: title })}
                className={
                  expanded
                    ? undefined
                    : 'text-fg-dim opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100'
                }
                onClick={() => {
                  cancel()
                  apply(withChordRemoved(current, i, isMac))
                }}
              />
            </span>
          )
        })}
        {current.length === 0 && !recordingAt(null) ? (
          <span className="text-fg-muted text-ui-sm">{d.keyboard.unassigned}</span>
        ) : null}
        {recordingAt(null) ? recorder : null}
        {canAddChord(current) && !recordingAt(null) ? (
          <IconButton
            icon={PlusIcon}
            label={fmt(d.keyboard.addFor, { command: title })}
            className={
              current.length === 0 || expanded
                ? undefined
                : 'text-fg-dim opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
            }
            onClick={() => startRecording(null)}
          />
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
      <DesktopNote specs={current} />
      {ignored && mode.kind === 'idle' ? (
        <WarningNote>
          {fmt(d.keyboard.ignored, {
            value: ignored.value,
            reason: problemText(ignored.problem, d, isMac),
          })}
        </WarningNote>
      ) : null}
    </>
  )

  return (
    <>
      <TableRow
        data-source={sources.label ?? 'default'}
        data-expanded={expanded || undefined}
        className="group/row hover:bg-surface-2"
      >
        <TableCell className="relative py-1.5 pl-3 align-top whitespace-normal">
          <CustomBar on={sources.label === 'user'} />
          <RowToggle
            label={fmt(d.keyboard.detailsFor, { command: title })}
            expanded={expanded}
            controls={detailId}
            onToggle={toggle}
            onCollapse={collapse}
            toggleRef={toggleRef}
          >
            <div className="truncate text-fg text-ui-base">{title}</div>
            <div className="truncate font-mono text-fg-muted text-ui-xs">{id}</div>
          </RowToggle>
        </TableCell>
        <TableCell className="relative py-1.5 align-top whitespace-normal">
          {expanded ? <ReadOnlyChords specs={current} /> : editor}
        </TableCell>
        <TableCell className="py-1.5 align-top whitespace-normal">
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <SourceLabel label={sources.label} presetName={presetName} />
              {sources.label && sources.dropped.length > 0 ? (
                <span className="text-fg-muted text-ui-xs">
                  {fmt(d.keyboard.dropped, {
                    keys: sources.dropped.map((spec) => chordText(spec, isMac)).join(' '),
                  })}
                </span>
              ) : null}
            </div>
            {override !== undefined ? (
              <IconButton
                icon={ArrowCounterClockwiseIcon}
                label={fmt(d.keyboard.resetFor, { command: title })}
                onClick={() => {
                  cancel()
                  resetKeybinding(id)
                }}
              />
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {expanded ? (
        <BindingDetail
          id={detailId}
          title={title}
          sources={sources}
          presetName={presetName}
          active={editor}
          onCollapse={collapse}
          onBack={() => {
            cancel()
            resetKeybinding(id)
          }}
          onUnbind={() => {
            cancel()
            setKeybinding(id, null)
          }}
        />
      ) : null}
    </>
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

interface Replacing {
  commands: string[]
  existing: TerminalKeyRow | null
}

const CUSTOM_SEND = 'custom'

type SendChoice = SendActionKey | typeof CUSTOM_SEND

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
  const [choice, setChoice] = useState<SendChoice>(
    previous ? (sendActionKey(previous.send) ?? CUSTOM_SEND) : SEND_ACTION_KEYS[0],
  )
  const [type, setType] = useState<TerminalSendType>(previous?.send.type ?? 'text')
  const [value, setValue] = useState(previous?.send.value ?? '')
  const [recording, setRecording] = useState(previous === null)
  const [problem, setProblem] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<Replacing | null>(null)
  const keys = spec ? chordText(spec, isMac) : ''
  const custom = choice === CUSTOM_SEND

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
    const send: TerminalSend = choice === CUSTOM_SEND ? { type, value } : actionSend(choice)
    if (!spec) {
      setProblem(d.keyboard.needsShortcut)
      return
    }
    if (sendData(send) === null) {
      setProblem(d.keyboard.badSend[send.type])
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
        <SelectField
          label={d.keyboard.sendAction}
          value={choice}
          onChange={(v) => {
            setChoice(v)
            setReplacing(null)
          }}
          options={[
            ...SEND_ACTION_KEYS.map((key) => ({
              value: key as SendChoice,
              label: d.keyboard.sendActions[key],
            })),
            { value: CUSTOM_SEND, label: d.keyboard.customSend },
          ]}
          width="w-fit min-w-44"
        />
      </div>
      {custom ? (
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
        </div>
      ) : null}
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

function TerminalKeyLine({
  entry,
  presetName,
  expanded = false,
  onToggle = () => {},
}: {
  entry: TerminalKeySources
  presetName: string | null
  expanded?: boolean
  onToggle?: () => void
}): JSX.Element {
  const d = useDict()
  const [editing, setEditing] = useState(false)
  const { row } = entry
  const keys = chordText(row.spec, isMac)
  const shadowedBy = terminalKeyConflicts(row.spec, isMac)[0]
  const action = sendActionText(row.send, d)
  const detailId = `terminal-key-detail-${row.signature}`
  const { toggleRef, toggle, collapse } = useCollapse(expanded, onToggle, () => setEditing(false))
  if (editing) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={3} className="py-1.5 whitespace-normal">
          <TerminalKeyEditor previous={row} onDone={() => setEditing(false)} />
        </TableCell>
      </TableRow>
    )
  }
  const editor = (
    <>
      <span className="group/chip inline-flex items-center gap-0.5">
        <button
          type="button"
          className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-brand"
          aria-label={fmt(d.keyboard.editFor, { keys })}
          onClick={() => setEditing(true)}
        >
          <Kbd className="text-fg">{keys}</Kbd>
        </button>
        <IconButton
          icon={XIcon}
          label={fmt(d.keyboard.removeFor, { keys })}
          className={
            expanded
              ? undefined
              : 'text-fg-dim opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100'
          }
          onClick={() => removeTerminalKey(row, isMac)}
        />
      </span>
      {shadowedBy ? (
        <WarningNote>
          {fmt(d.keyboard.shadowed, { command: commandTitle(shadowedBy, d) })}
        </WarningNote>
      ) : null}
      <DesktopNote specs={[row.spec]} />
    </>
  )
  return (
    <>
      <TableRow
        data-source={entry.label ?? 'default'}
        data-expanded={expanded || undefined}
        className="group/row hover:bg-surface-2"
      >
        <TableCell className="relative py-1.5 pl-3 align-top whitespace-normal">
          <CustomBar on={entry.label === 'user'} />
          <RowToggle
            label={fmt(d.keyboard.detailsFor, { command: keys })}
            expanded={expanded}
            controls={detailId}
            onToggle={toggle}
            onCollapse={collapse}
            toggleRef={toggleRef}
          >
            {action ? (
              <>
                <div className="truncate text-fg text-ui-base">{action}</div>
                <div className="truncate font-mono text-fg-muted text-ui-xs">
                  {sendText(row.send)}
                </div>
              </>
            ) : (
              <>
                <div className="truncate font-mono text-fg text-ui-base">{sendText(row.send)}</div>
                <div className="truncate text-fg-muted text-ui-xs">
                  {d.keyboard.sendTypes[row.send.type]}
                </div>
              </>
            )}
          </RowToggle>
        </TableCell>
        <TableCell className="py-1.5 align-top whitespace-normal">
          {expanded ? <Kbd className="text-fg">{keys}</Kbd> : editor}
        </TableCell>
        <TableCell className="py-1.5 align-top whitespace-normal">
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <SourceLabel label={entry.label} presetName={presetName} />
            </div>
            {row.preset && row.userKey ? (
              <IconButton
                icon={ArrowCounterClockwiseIcon}
                label={fmt(d.keyboard.resetFor, { command: keys })}
                onClick={() => resetTerminalKey(row, isMac)}
              />
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TerminalKeyDetail
          id={detailId}
          keys={keys}
          entry={entry}
          presetName={presetName}
          active={editor}
          onCollapse={collapse}
          onBack={() => resetTerminalKey(row, isMac)}
          onUnbind={() => {
            collapse()
            removeTerminalKey(row, isMac)
          }}
        />
      ) : null}
    </>
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

type View = 'active' | 'changes'

function ViewSwitch({
  view,
  total,
  onChange,
}: {
  view: View
  total: number
  onChange: (view: View) => void
}): JSX.Element {
  const d = useDict()
  const options: { value: View; label: string }[] = [
    { value: 'active', label: d.keyboard.viewActive },
    { value: 'changes', label: fmt(d.keyboard.viewChanges, { count: total }) },
  ]
  return (
    <fieldset aria-label={d.keyboard.view} className="m-0 flex shrink-0 gap-1 border-0 p-0">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={view === o.value}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-md border px-2 text-ui-sm outline-none focus-visible:ring-1 focus-visible:ring-brand ${
            view === o.value
              ? 'border-line-strong bg-surface-3 text-fg'
              : 'border-line text-fg-muted hover:bg-surface-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}

export function KeyboardSection(): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [view, setView] = useState<View>('active')
  const [open, setOpen] = useState<string | null>(null)
  const terminalKeys = useSettingsStore((s) => s.terminalKeys)
  const terminalKeymap = useSettingsStore((s) => s.terminalKeymap)
  const names = useKeymapNames()
  const total = useChangeTotal()
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
  const toggle = (key: string) => (): void => setOpen((was) => (was === key ? null : key))

  return (
    <section aria-label={d.keyboard.title}>
      <SectionHead title={d.keyboard.title} desc={d.keyboard.desc} />
      <KeymapCombo onShowChanges={() => setView('changes')} />
      <div className="mb-2 flex items-center gap-2">
        <ViewSwitch view={view} total={total} onChange={setView} />
        {view === 'active' ? (
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
        ) : null}
      </div>
      {view === 'changes' ? (
        <ChangesView appName={names.app} textName={names.terminal} />
      ) : visible.length === 0 && visibleSends.length === 0 && !adding ? (
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
                  <KeybindingRow
                    key={r.id}
                    id={r.id}
                    title={r.title}
                    presetName={names.app}
                    expanded={open === `cmd:${r.id}`}
                    onToggle={toggle(`cmd:${r.id}`)}
                  />
                ))}
              </Fragment>
            ))}
            {visibleSends.length > 0 || adding ? (
              <GroupHead name={d.keyboard.groups.textEditing} />
            ) : null}
            {visibleSends.map((r) => (
              <TerminalKeyLine
                key={r.row.signature}
                entry={r}
                presetName={names.terminal}
                expanded={open === `key:${r.row.signature}`}
                onToggle={toggle(`key:${r.row.signature}`)}
              />
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
      {view === 'active' ? (
        <div className="mt-2 flex">
          <Button variant="outline" size="sm" disabled={adding} onClick={() => setAdding(true)}>
            <PlusIcon />
            {d.keyboard.addTerminalKey}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
