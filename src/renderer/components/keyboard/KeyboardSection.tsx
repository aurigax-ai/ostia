import { commands } from '@/commands/registry'
import { ControlRow } from '@/components/settings/ControlRow'
import { SelectField } from '@/components/settings/SelectField'
import { SectionHead } from '@/components/settings/SettingsGroup'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmt, useDict } from '@/lib/app/useDict'
import { BASE_LANGUAGE } from '@/lib/extensions/languagePacks'
import { sendActionKey } from '@/lib/keyboard/actionSends'
import { bindableIds, chordsOf, useBindings } from '@/lib/keyboard/chords'
import { type TerminalKeyRow, terminalKeymapOf } from '@/lib/keyboard/keyPresets'
import { commandGroup, groupRows, terminalKeySources } from '@/lib/keyboard/keySources'
import type { LinkClick } from '@/lib/settings/terminalPaneSettings'
import { isMac, platform } from '@/platform'
import { appKeymap, keymapChoices, useKeymapStore } from '@/stores/app/keymapStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { PlusIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import { type ChordSpec, chordText, overlaps } from '@shared/keyboard/chordSpec'
import { Fragment, useState, useSyncExternalStore } from 'react'
import { ChangesView, useChangeTotal } from './ChangesView'
import { KeySearch, boundTo } from './KeySearch'
import { KeybindingRow } from './KeybindingRow'
import { KeymapCombo } from './KeymapCombo'
import { TerminalKeyEditor } from './TerminalKeyEditor'
import { TerminalKeyLine } from './TerminalKeyLine'
import { KEY_TABLE_COLUMNS, commandTitle, sendText, terminalKeymapLabel } from './keyboardLabels'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)

const commandsVersion = (): number => commands.version()

function matchesQuery(row: { id: string; title: string; english: string }, q: string): boolean {
  const keys = chordsOf(row.id, isMac).map((spec) => chordText(spec, isMac).toLowerCase())
  return [row.title, row.english, row.id, ...keys].some((t) => t.toLowerCase().includes(q))
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
          className={`h-7 rounded-md border px-2 text-ui-sm ${
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

function LinkClickRow(): JSX.Element {
  const d = useDict()
  const linkClick = useSettingsStore((s) => s.terminal.linkClick)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const click = (shift: boolean): string =>
    chordText({ ctrl: !isMac, meta: isMac, shift, alt: false, key: d.terminalLinks.click }, isMac)
  const label = fmt(d.keyboard.linkClick, { click: click(false) })
  return (
    <ControlRow label={label} desc={fmt(d.keyboard.linkClickDesc, { shiftClick: click(true) })}>
      <SelectField<LinkClick>
        value={linkClick}
        onChange={(v) => setTerminal({ linkClick: v })}
        label={label}
        options={[
          { value: 'app', label: d.keyboard.linkClickApp },
          { value: 'system', label: d.keyboard.linkClickSystem },
        ]}
      />
    </ControlRow>
  )
}

export function KeyboardSection(): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const [chord, setChord] = useState<ChordSpec | null>(null)
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
  const visible = chord
    ? rows.filter((r) => boundTo(r.id, chord))
    : q
      ? rows.filter((r) => matchesQuery(r, q))
      : rows
  const visibleSends = chord
    ? sends.filter((r) => overlaps(r.row.spec, chord))
    : q
      ? sends.filter((r) => matchesTerminalRow(r.row, q, d))
      : sends
  const toggle = (key: string) => (): void => setOpen((was) => (was === key ? null : key))

  return (
    <section aria-label={d.keyboard.title}>
      <SectionHead title={d.keyboard.title} desc={d.keyboard.desc} />
      <KeymapCombo onShowChanges={() => setView('changes')} />
      <LinkClickRow />
      <div className="mb-2 flex items-center gap-2">
        <ViewSwitch view={view} total={total} onChange={setView} />
        {view === 'active' ? (
          <KeySearch query={query} onQuery={setQuery} chord={chord} onChord={setChord} />
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
