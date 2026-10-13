import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table'
import { fmt, useDict } from '@/i18n/useDict'
import { baseChords, chordsOf, keymapBindings, useBindings } from '@/lib/keys/chords'
import {
  type CommandChange,
  type TerminalChange,
  appPresetChanges,
  presetSendFor,
  textPresetChanges,
  userChangeCount,
  userChanges,
} from '@/lib/keys/keyChanges'
import { layerOf } from '@/lib/keys/keySources'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import { chordText } from '@shared/keyboard/chordSpec'
import { OSTIA_KEYMAP } from '@shared/keyboard/keyboardPresets'
import type { TerminalSend } from '@shared/keyboard/terminalKeys'
import { Fragment, type ReactNode, useState } from 'react'
import { KEY_TABLE_COLUMNS, commandTitle, keysLabel, sendLabel, sendText } from './keyboardLabels'

export function useChangeTotal(): number {
  const keybindings = useSettingsStore((s) => s.keybindings)
  const terminalKeys = useSettingsStore((s) => s.terminalKeys)
  const terminalKeymap = useSettingsStore((s) => s.terminalKeymap)
  useBindings()
  return (
    userChangeCount(userChanges(keybindings, terminalKeys)) +
    appPresetChanges(keymapBindings(), isMac).length +
    textPresetChanges(terminalKeymap, isMac).length
  )
}

function chordList(texts: readonly string[], none: string): ReactNode {
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

function SectionHead({
  title,
  action,
}: {
  title: string
  action?: ReactNode
}): JSX.Element {
  return (
    <TableRow className="border-line hover:bg-transparent">
      <TableHead colSpan={3} scope="colgroup" className="h-8 pt-3 pl-3 text-fg-muted text-ui-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{title}</span>
          {action}
        </div>
      </TableHead>
    </TableRow>
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

function CommandLine({
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

function TerminalLine({
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

function PresetLine({
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

export function ChangesView({
  appName,
  textName,
}: {
  appName: string | null
  textName: string | null
}): JSX.Element {
  const d = useDict()
  const keybindings = useSettingsStore((s) => s.keybindings)
  const terminalKeys = useSettingsStore((s) => s.terminalKeys)
  const terminalKeymap = useSettingsStore((s) => s.terminalKeymap)
  const settings = useSettingsStore.getState
  useBindings()
  const [asking, setAsking] = useState(false)
  const mine = userChanges(keybindings, terminalKeys)
  const byTitle = (a: CommandChange, b: CommandChange): number =>
    commandTitle(a.id, d).localeCompare(commandTitle(b.id, d))
  const customCommands = [...mine.customCommands].sort(byTitle)
  const removedCommands = [...mine.removedCommands].sort(byTitle)
  const appChanges = appPresetChanges(keymapBindings(), isMac).sort((a, b) =>
    commandTitle(a.id, d).localeCompare(commandTitle(b.id, d)),
  )
  const textChanges = textPresetChanges(terminalKeymap, isMac)
  const customCount = customCommands.length + mine.customKeys.length
  const removedCount = removedCommands.length + mine.removedKeys.length
  const total = customCount + removedCount + appChanges.length + textChanges.length
  const ostia = d.keyboard.appKeymaps.ostia

  const revertCommands = (list: CommandChange[]): void => {
    for (const c of list) settings().resetKeybinding(c.id)
  }
  const revertKeys = (list: TerminalChange[]): void => {
    for (const k of list) settings().resetTerminalKey(k.keys)
  }
  const revertEverything = (): void => {
    const s = settings()
    s.setKeybindings({})
    s.setTerminalKeys({})
    s.setKeymap(OSTIA_KEYMAP)
    s.setTerminalKeymap(OSTIA_KEYMAP)
    setAsking(false)
  }

  if (total === 0) {
    return <p className="py-2 text-fg-muted text-ui-sm">{d.keyboard.changesNone}</p>
  }

  const sectionTitle = (template: string, count: number): string => fmt(template, { count })
  const customTitle = sectionTitle(d.keyboard.changesCustom, customCount)
  const removedTitle = sectionTitle(d.keyboard.changesRemoved, removedCount)

  return (
    <>
      <table
        data-slot="table"
        aria-label={fmt(d.keyboard.viewChanges, { count: total })}
        className="w-full table-fixed caption-bottom text-ui-base"
      >
        <colgroup>
          {KEY_TABLE_COLUMNS.map((width) => (
            <col key={width} className={width} />
          ))}
        </colgroup>
        <TableBody>
          {customCount > 0 ? (
            <Fragment>
              <SectionHead
                title={customTitle}
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={fmt(d.keyboard.revertSectionFor, { section: customTitle })}
                    onClick={() => {
                      revertCommands(customCommands)
                      revertKeys(mine.customKeys)
                    }}
                  >
                    {d.keyboard.revertSection}
                  </Button>
                }
              />
              {customCommands.map((c) => (
                <CommandLine key={c.id} change={c} presetName={appName} custom />
              ))}
              {mine.customKeys.map((k) => (
                <TerminalLine
                  key={k.keys}
                  change={k}
                  terminalKeymap={terminalKeymap}
                  presetName={textName}
                />
              ))}
            </Fragment>
          ) : null}
          {removedCount > 0 ? (
            <Fragment>
              <SectionHead
                title={removedTitle}
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={fmt(d.keyboard.revertSectionFor, { section: removedTitle })}
                    onClick={() => {
                      revertCommands(removedCommands)
                      revertKeys(mine.removedKeys)
                    }}
                  >
                    {d.keyboard.revertSection}
                  </Button>
                }
              />
              {removedCommands.map((c) => (
                <CommandLine key={c.id} change={c} presetName={appName} custom={false} />
              ))}
              {mine.removedKeys.map((k) => (
                <TerminalLine
                  key={k.keys}
                  change={k}
                  terminalKeymap={terminalKeymap}
                  presetName={textName}
                />
              ))}
            </Fragment>
          ) : null}
          {appChanges.length > 0 ? (
            <Fragment>
              <SectionHead
                title={fmt(d.keyboard.changesPreset, {
                  layer: d.keyboard.keymap,
                  name: appName ?? '',
                  count: appChanges.length,
                })}
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={fmt(d.keyboard.backToOstiaFor, { layer: d.keyboard.keymap })}
                    onClick={() => settings().setKeymap(OSTIA_KEYMAP)}
                  >
                    {d.keyboard.backToOstia}
                  </Button>
                }
              />
              {appChanges.map((c) => (
                <PresetLine
                  key={c.id}
                  title={commandTitle(c.id, d)}
                  sub={c.id}
                  after={chordList(c.after ? c.after.split(' / ') : [], d.keyboard.unassigned)}
                  ostia={fmt(d.keyboard.ostiaHas, {
                    keys: c.before ?? d.keyboard.unassigned,
                  })}
                />
              ))}
            </Fragment>
          ) : null}
          {textChanges.length > 0 ? (
            <Fragment>
              <SectionHead
                title={fmt(d.keyboard.changesPreset, {
                  layer: d.keyboard.terminalKeymap,
                  name: textName ?? '',
                  count: textChanges.length,
                })}
                action={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={fmt(d.keyboard.backToOstiaFor, {
                      layer: d.keyboard.terminalKeymap,
                    })}
                    onClick={() => settings().setTerminalKeymap(OSTIA_KEYMAP)}
                  >
                    {d.keyboard.backToOstia}
                  </Button>
                }
              />
              {textChanges.map((c) => {
                const shown = c.after ?? c.before
                return (
                  <PresetLine
                    key={c.signature}
                    title={shown ? sendLabel(shown, d) : c.keys}
                    sub={c.after ? sendText(c.after) : null}
                    after={
                      <span className="flex flex-wrap items-center gap-1">
                        <Kbd className="text-fg">{c.keys}</Kbd>
                        {c.after ? null : (
                          <span className="text-fg-muted text-ui-sm">
                            {d.keyboard.notTranslated}
                          </span>
                        )}
                      </span>
                    }
                    ostia={fmt(d.keyboard.ostiaHas, {
                      keys: c.before ? sendLabel(c.before, d) : d.keyboard.notTranslated,
                    })}
                  />
                )
              })}
            </Fragment>
          ) : null}
        </TableBody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-line border-t pt-2">
        {asking ? (
          <>
            <p role="alert" className="text-warn-fg text-ui-sm">
              {fmt(d.keyboard.revertEverythingAsk, { count: total, product: ostia })}
            </p>
            <Button variant="ghost" size="xs" onClick={() => setAsking(false)}>
              {d.keyboard.cancel}
            </Button>
            <Button variant="destructive" size="xs" onClick={revertEverything}>
              {d.keyboard.revertEverythingConfirm}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
            {d.keyboard.revertEverything}
          </Button>
        )}
      </div>
    </>
  )
}
