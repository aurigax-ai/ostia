import { ArrowCounterClockwiseIcon, PlusIcon, XIcon } from '@phosphor-icons/react'
import {
  type ChordProblem,
  type ChordSpec,
  type ChordValue,
  chordText,
  chordTexts,
  DIGIT_RANGE,
  formatScopedChord,
  usedByMonaco,
} from '@shared/keyboard/chordSpec'
import { useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { TableCell, TableRow } from '@/components/ui/table'
import { fmt, useDict } from '@/lib/app/useDict'
import {
  baseChords,
  bindingProblem,
  checkBinding,
  chordsOf,
  chordsWithout,
  conflictsWith,
  keymapBindings,
  WORKSPACE_GOTO,
  workspaceDigit,
} from '@/lib/keyboard/chords'
import { removeTerminalKey, type TerminalKeyRow, terminalKeyFor } from '@/lib/keyboard/keyPresets'
import {
  canAddChord,
  commandSources,
  overrideFor,
  withChordAdded,
  withChordRemoved,
  withChordReplaced,
} from '@/lib/keyboard/keySources'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { BindingDetail, RowToggle } from './BindingDetail'
import { ChordRecorder } from './ChordRecorder'
import { CustomBar, DesktopNote, SourceLabel, TerminalLosesNote } from './KeyRowNotes'
import { commandTitle, problemText, sendText } from './keyboardLabels'
import { keepChords, useCollapse } from './keyRows'

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

function recordedChord(id: string, spec: ChordSpec): ChordSpec {
  if (id !== WORKSPACE_GOTO || workspaceDigit(spec.key) === null) return spec
  return { ...spec, key: DIGIT_RANGE }
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

function KeyNotice({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      data-slot="key-notice"
      className="motion-enter absolute top-full left-0 origin-top-left z-20 mt-0.5 w-max max-w-md rounded-md border border-line bg-popover p-2 text-popover-foreground shadow-md"
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

interface ChordRecording {
  mode: Mode
  refusal: string | null
  apply: (next: string[]) => void
  save: (
    spec: ChordSpec,
    target: Target,
    replace: string[],
    terminal: TerminalKeyRow | null,
  ) => void
  onRecord: (raw: ChordSpec) => void
  cancel: () => void
  startRecording: (target: Target) => void
  recordingAt: (target: Target) => boolean
}

function useChordRecording(id: string, current: readonly ChordSpec[]): ChordRecording {
  const d = useDict()
  const setKeybinding = useSettingsStore((s) => s.setKeybinding)
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding)
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [refusal, setRefusal] = useState<string | null>(null)

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

  return { mode, refusal, apply, save, onRecord, cancel, startRecording, recordingAt }
}

function ChordEditor({
  id,
  title,
  current,
  expanded,
  ignored,
  recording,
}: {
  id: string
  title: string
  current: readonly ChordSpec[]
  expanded: boolean
  ignored: ReturnType<typeof firstIgnored>
  recording: ChordRecording
}): JSX.Element {
  const d = useDict()
  const { mode, refusal, apply, save, onRecord, cancel, startRecording, recordingAt } = recording
  const recorder = (
    <RecordingChip
      label={fmt(d.keyboard.recordFor, { command: title })}
      onRecord={onRecord}
      onCancel={cancel}
    />
  )

  return (
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
                className="rounded-sm"
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
          {refusal ? <Notice tone="error">{refusal}</Notice> : null}
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
      <TerminalLosesNote id={id} specs={current} />
      {ignored && mode.kind === 'idle' ? (
        <Notice>
          {fmt(d.keyboard.ignored, {
            value: ignored.value,
            reason: problemText(ignored.problem, d, isMac),
          })}
        </Notice>
      ) : null}
    </>
  )
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
  const current = chordsOf(id, isMac)
  const sources = commandSources(id, user, keymapBindings(), isMac)
  const ignored = override ? firstIgnored(id, override) : null
  const detailId = `binding-detail-${id}`

  const recording = useChordRecording(id, current)
  const { cancel } = recording
  const { toggleRef, toggle, collapse } = useCollapse(expanded, onToggle, cancel)

  const editor = (
    <ChordEditor
      id={id}
      title={title}
      current={current}
      expanded={expanded}
      ignored={ignored}
      recording={recording}
    />
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
        <Notice key={other}>
          {fmt(d.keyboard.conflict, { keys, command: commandTitle(other, d) })}
        </Notice>
      ))}
      {pending.terminal ? (
        <Notice>
          {fmt(d.keyboard.terminalConflict, { keys, send: sendText(pending.terminal.send) })}
        </Notice>
      ) : null}
      {pending.monaco ? <Notice>{fmt(d.keyboard.monaco, { keys })}</Notice> : null}
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
