import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { PlusIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import { type ChordSpec, chordText, overlaps } from '@shared/keyboard/chordSpec'
import {
  isIdentityRemap,
  REMAP_KEYS,
  REMAP_TARGETS,
  type RemapTarget,
  remapTarget,
} from '@shared/keyboard/modifierRemap'
import { Fragment, type JSX, useState, useSyncExternalStore } from 'react'
import { commands } from '@/commands/registry'
import { Segmented } from '@/components/common/Segmented'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
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
import { ChangesView, useChangeTotal } from './ChangesView'
import { KeybindingRow } from './KeybindingRow'
import { KeymapCombo } from './KeymapCombo'
import { boundTo, KeySearch } from './KeySearch'
import { commandTitle, KEY_TABLE_COLUMNS, sendText, terminalKeymapLabel } from './keyboardLabels'
import { TerminalKeyEditor } from './TerminalKeyEditor'
import { TerminalKeyLine } from './TerminalKeyLine'

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
  return <Segmented label={d.keyboard.view} value={view} options={options} onChange={onChange} />
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
          { value: 'app', label: fmt(d.keyboard.linkClickApp, { product: PRODUCT_DISPLAY_NAME }) },
          { value: 'system', label: d.keyboard.linkClickSystem },
        ]}
      />
    </ControlRow>
  )
}

function ModifierKeysGroup(): JSX.Element {
  const d = useDict()
  const table = useSettingsStore((s) => s.modifierRemap)
  const setModifierRemap = useSettingsStore((s) => s.setModifierRemap)
  const options = REMAP_TARGETS.map((value) => ({
    value,
    label: d.keyboard.modifierTargets[value],
  }))
  return (
    <SettingsGroup
      title={d.keyboard.modifierKeys}
      desc={d.keyboard.modifierKeysDesc}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={isIdentityRemap(table)}
          onClick={() => setModifierRemap({})}
        >
          {d.keyboard.modifierReset}
        </Button>
      }
    >
      {REMAP_KEYS.map((key) => (
        <ControlRow key={key} label={d.keyboard.modifierKeyNames[key]}>
          <SelectField<RemapTarget>
            value={remapTarget(table, key)}
            onChange={(v) => setModifierRemap({ ...table, [key]: v })}
            label={d.keyboard.modifierKeyNames[key]}
            options={options}
          />
        </ControlRow>
      ))}
    </SettingsGroup>
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
    <SettingsPage title={d.keyboard.title} desc={d.keyboard.desc}>
      <KeymapCombo onShowChanges={() => setView('changes')} />
      <LinkClickRow />
      {isMac ? <ModifierKeysGroup /> : null}
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
    </SettingsPage>
  )
}
