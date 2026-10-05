import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import {
  type ChordProblem,
  type ChordSpec,
  DIGIT_RANGE,
  chordText,
  formatChord,
  sameChord,
  specFromEvent,
  usedByMonaco,
} from '@shared/chordSpec'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { commandWording, commands } from '../commands/registry'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import {
  WORKSPACE_GOTO,
  baseChord,
  bindableIds,
  bindingProblem,
  checkBinding,
  chordOf,
  conflictsWith,
  useBindings,
  workspaceDigit,
} from '../lib/chords'
import { BASE_LANGUAGE } from '../lib/languagePacks'
import { isMac, platform } from '../platform'
import { useExtensionsStore } from '../stores/extensionsStore'
import { keymapChoices, useKeymapStore } from '../stores/keymapStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ControlRow, SectionHead, SelectField, WarningNote } from './SettingsPanel'
import { Button } from './ui/button'
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
  const spec = chordOf(row.id, isMac)
  const keys = spec ? chordText(spec, isMac).toLowerCase() : ''
  return (
    [row.title, row.english, row.id].some((t) => t.toLowerCase().includes(q)) || keys.includes(q)
  )
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
}

type Mode = { kind: 'idle' } | { kind: 'recording' } | ({ kind: 'pending' } & Pending)

export function KeybindingRow({ id, title }: { id: string; title: string }): JSX.Element {
  const d = useDict()
  const override = useSettingsStore((s) => (id in s.keybindings ? s.keybindings[id] : undefined))
  const setKeybinding = useSettingsStore((s) => s.setKeybinding)
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding)
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [refusal, setRefusal] = useState<string | null>(null)
  const current = chordOf(id, isMac)
  const ignored = typeof override === 'string' ? checkBinding(id, override, isMac) : null

  const save = (spec: ChordSpec, replace: string[]): void => {
    for (const other of replace) setKeybinding(other, null)
    const fallback = baseChord(id, isMac)
    if (fallback && sameChord(fallback, spec)) resetKeybinding(id)
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
    if (conflicts.length === 0 && !monaco) save(spec, [])
    else setMode({ kind: 'pending', spec, conflicts, monaco })
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
            onConfirm={() => save(mode.spec, mode.conflicts)}
            onCancel={cancel}
          />
        ) : current ? (
          <Kbd>{chordText(current, isMac)}</Kbd>
        ) : (
          <span className="text-fg-muted text-ui-sm">{d.keyboard.unassigned}</span>
        )}
        {refusal ? (
          <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
            {refusal}
          </p>
        ) : null}
        {ignored && typeof override === 'string' && mode.kind === 'idle' ? (
          <p className="mt-1 text-attn-fg text-ui-sm">
            {fmt(d.keyboard.ignored, {
              value: override,
              reason: problemText(ignored, d, isMac),
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
      {pending.monaco ? <WarningNote>{fmt(d.keyboard.monaco, { keys })}</WarningNote> : null}
      <div className="flex gap-1">
        <Button size="xs" onClick={onConfirm}>
          {pending.conflicts.length > 0 ? d.keyboard.replace : d.keyboard.useAnyway}
        </Button>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          {d.keyboard.cancel}
        </Button>
      </div>
    </div>
  )
}

const DEFAULT_KEYMAP = 'default'

function KeymapPicker(): JSX.Element {
  const d = useDict()
  const ref = useSettingsStore((s) => s.keymap)
  const setKeymap = useSettingsStore((s) => s.setKeymap)
  const list = useExtensionsStore((s) => s.list)
  const choices = keymapChoices(list, platform)
  const chosen = choices.find((c) => c.ref === ref)
  const loaded = useKeymapStore((s) => (chosen && s.ref === chosen.ref ? s.loaded : null))
  const error = useKeymapStore((s) => (chosen && s.ref === chosen.ref ? s.error : null))
  return (
    <div className="mb-3">
      <ControlRow label={d.keyboard.keymap} desc={d.keyboard.keymapDesc}>
        <SelectField
          label={d.keyboard.keymap}
          value={chosen?.ref ?? DEFAULT_KEYMAP}
          onChange={(v) => setKeymap(v === DEFAULT_KEYMAP ? null : v)}
          options={[
            { value: DEFAULT_KEYMAP, label: d.keyboard.keymapDefault },
            ...choices.map((c) => ({ value: c.ref, label: c.label })),
          ]}
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
    </div>
  )
}

export function KeyboardSection(): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const keybindings = useSettingsStore((s) => s.keybindings)
  const setKeybindings = useSettingsStore((s) => s.setKeybindings)
  useBindings()
  useSyncExternalStore(subscribeCommands, commandsVersion)

  const rows = bindableIds()
    .map((id) => ({
      id,
      title: commandTitle(id, d),
      english: commandTitle(id, BASE_LANGUAGE.catalog),
    }))
    .sort((a, b) => a.title.localeCompare(b.title))

  const q = query.trim().toLowerCase()
  const visible = q ? rows.filter((r) => matchesQuery(r, q)) : rows

  return (
    <section aria-label={d.keyboard.title}>
      <SectionHead title={d.keyboard.title} desc={d.keyboard.desc} />
      <KeymapPicker />
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
          disabled={Object.keys(keybindings).length === 0}
          onClick={() => setKeybindings({})}
        >
          {d.keyboard.resetAll}
        </Button>
      </div>
      {visible.length === 0 ? (
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
            {visible.map((r) => (
              <KeybindingRow key={r.id} id={r.id} title={r.title} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
