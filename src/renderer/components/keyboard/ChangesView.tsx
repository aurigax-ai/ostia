import { Fragment, type JSX, type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { TableBody, TableHead, TableRow } from '@/components/ui/table'
import { fmt, useDict } from '@/lib/app/useDict'
import { keymapBindings, useBindings } from '@/lib/keyboard/chords'
import { OSTIA_KEYMAP } from '@/lib/keyboard/keyboardPresets'
import {
  appPresetChanges,
  type CommandChange,
  type TerminalChange,
  textPresetChanges,
  userChangeCount,
  userChanges,
} from '@/lib/keyboard/keyChanges'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { CommandLine, chordList, PresetLine, TerminalLine } from './ChangeLines'
import { commandTitle, KEY_TABLE_COLUMNS, sendLabel, sendText } from './keyboardLabels'

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

function SectionHead({ title, action }: { title: string; action?: ReactNode }): JSX.Element {
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

function AppPresetSection({
  appChanges,
  appName,
}: {
  appChanges: ReturnType<typeof appPresetChanges>
  appName: string | null
}): JSX.Element | null {
  const d = useDict()
  const settings = useSettingsStore.getState
  if (appChanges.length === 0) return null
  return (
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
  )
}

function TextPresetSection({
  textChanges,
  textName,
}: {
  textChanges: ReturnType<typeof textPresetChanges>
  textName: string | null
}): JSX.Element | null {
  const d = useDict()
  const settings = useSettingsStore.getState
  if (textChanges.length === 0) return null
  return (
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
                  <span className="text-fg-muted text-ui-sm">{d.keyboard.notTranslated}</span>
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
  )
}

function RevertEverything({
  asking,
  setAsking,
  total,
  onConfirm,
}: {
  asking: boolean
  setAsking: (asking: boolean) => void
  total: number
  onConfirm: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-line border-t pt-2">
      {asking ? (
        <>
          <p role="alert" className="text-warn-fg text-ui-sm">
            {fmt(d.keyboard.revertEverythingAsk, {
              count: total,
              product: d.keyboard.appKeymaps.ostia,
            })}
          </p>
          <Button variant="ghost" size="xs" onClick={() => setAsking(false)}>
            {d.keyboard.cancel}
          </Button>
          <Button variant="destructive" size="xs" onClick={onConfirm}>
            {d.keyboard.revertEverythingConfirm}
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
          {d.keyboard.revertEverything}
        </Button>
      )}
    </div>
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
          <AppPresetSection appChanges={appChanges} appName={appName} />
          <TextPresetSection textChanges={textChanges} textName={textName} />
        </TableBody>
      </table>
      <RevertEverything
        asking={asking}
        setAsking={setAsking}
        total={total}
        onConfirm={revertEverything}
      />
    </>
  )
}
