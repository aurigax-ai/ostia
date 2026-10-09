import { WarningNote } from '@/components/settings/SettingsPanel'
import { useSearchLeaf } from '@/components/settings/SettingsSearch'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { fmt, useDict } from '@/i18n/useDict'
import { keymapBindings } from '@/lib/keys/chords'
import {
  type PresetLayer,
  appPresetChanges,
  appPreview,
  textPresetChanges,
  textPreview,
  userChangeCount,
  userChanges,
} from '@/lib/keys/keyChanges'
import { terminalKeymapOf } from '@/lib/keys/keyPresets'
import { isMac, platform } from '@/platform'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { appKeymap, keymapChoices, useKeymapStore } from '@/stores/keymapStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { ArrowRightIcon, CaretRightIcon } from '@phosphor-icons/react'
import type { KeybindingMap } from '@shared/keyboard/chordSpec'
import {
  NATURAL_TEXT_EDITING,
  OSTIA_KEYMAP,
  keyboardPlatform,
  terminalKeymapsFor,
} from '@shared/keyboard/keyboardPresets'
import type { TerminalSend } from '@shared/keyboard/terminalKeys'
import { useEffect, useState } from 'react'
import {
  appKeymapLabel,
  commandTitle,
  keysLabel,
  problemText,
  sendLabel,
  terminalKeymapLabel,
} from './keyboardLabels'

interface Choice {
  value: string
  label: string
}

interface PresetChoice {
  layer: PresetLayer
  value: string
  label: string
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; bindings: KeybindingMap }
  | { status: 'failed'; error: string }

function useAppPresetBindings(ref: string | null): Loaded {
  const current = useKeymapStore((s) => (s.ref === ref ? s.loaded : null))
  const [state, setState] = useState<{ ref: string | null; loaded: Loaded }>({
    ref: null,
    loaded: { status: 'loading' },
  })
  const builtin = ref === OSTIA_KEYMAP
  useEffect(() => {
    if (ref === null || builtin || current) return
    let live = true
    window.ostia.keymaps
      .load(ref)
      .then((res) => {
        if (!live) return
        setState({
          ref,
          loaded: res.ok
            ? { status: 'ready', bindings: res.keymap.bindings }
            : { status: 'failed', error: res.error },
        })
      })
      .catch((err: unknown) => {
        if (live) {
          setState({
            ref,
            loaded: { status: 'failed', error: err instanceof Error ? err.message : String(err) },
          })
        }
      })
    return () => {
      live = false
    }
  }, [ref, builtin, current])
  if (builtin) return { status: 'ready', bindings: {} }
  if (current) return { status: 'ready', bindings: current.bindings }
  return state.ref === ref ? state.loaded : { status: 'loading' }
}

function keysOrNone(keys: string | null, none: string): JSX.Element {
  return keys ? (
    <Kbd className="text-fg">{keys}</Kbd>
  ) : (
    <span className="text-fg-muted">{none}</span>
  )
}

function sendOrNone(send: TerminalSend | null, none: string, d: ReturnType<typeof useDict>) {
  return send ? (
    <span className="text-fg">{sendLabel(send, d)}</span>
  ) : (
    <span className="text-fg-muted">{none}</span>
  )
}

function PresetPreview({
  choice,
  onApply,
  onCancel,
}: {
  choice: PresetChoice
  onApply: () => void
  onCancel: () => void
}): JSX.Element {
  const d = useDict()
  const user = useSettingsStore((s) => s.keybindings)
  const terminalKeys = useSettingsStore((s) => s.terminalKeys)
  const terminalKeymap = useSettingsStore((s) => s.terminalKeymap)
  useKeymapStore((s) => s.loaded)
  const loaded = useAppPresetBindings(choice.layer === 'app' ? choice.value : null)
  const name = choice.label
  const customNames = [
    ...Object.keys(user).map((id) => commandTitle(id, d)),
    ...Object.keys(terminalKeys).map((keys) => keysLabel(keys, isMac)),
  ]

  let body: JSX.Element
  let count = 0
  if (choice.layer === 'app' && loaded.status !== 'ready') {
    body =
      loaded.status === 'loading' ? (
        <p className="text-fg-muted text-ui-sm">{fmt(d.keyboard.previewLoading, { name })}</p>
      ) : (
        <WarningNote>{fmt(d.keyboard.previewFailed, { name, error: loaded.error })}</WarningNote>
      )
  } else if (choice.layer === 'app' && loaded.status === 'ready') {
    const plan = appPreview(keymapBindings(), loaded.bindings, user, isMac)
    count = plan.changes.length
    body = (
      <ul className="flex flex-col">
        {plan.changes.map((c) => (
          <li key={c.id} className="grid grid-cols-[42%_1fr] items-center gap-2 py-0.5 text-ui-sm">
            <span className="truncate text-fg">{commandTitle(c.id, d)}</span>
            <span className="flex flex-wrap items-center gap-1">
              {keysOrNone(c.before, d.keyboard.noKey)}
              <ArrowRightIcon className="size-3 shrink-0 text-fg-dim" aria-hidden />
              {keysOrNone(c.after, d.keyboard.noKey)}
              {plan.keptCustom.includes(c) ? (
                <span className="text-brand text-ui-xs">{d.keyboard.previewYoursStay}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    )
  } else {
    const plan = textPreview(terminalKeymap, choice.value, terminalKeys, isMac)
    count = plan.changes.length
    body = (
      <ul className="flex flex-col">
        {plan.changes.map((c) => (
          <li
            key={c.signature}
            className="grid grid-cols-[42%_1fr] items-center gap-2 py-0.5 text-ui-sm"
          >
            <Kbd className="w-fit text-fg">{c.keys}</Kbd>
            <span className="flex flex-wrap items-center gap-1">
              {sendOrNone(c.before, d.keyboard.notTranslated, d)}
              <ArrowRightIcon className="size-3 shrink-0 text-fg-dim" aria-hidden />
              {sendOrNone(c.after, d.keyboard.notTranslated, d)}
              {plan.keptCustom.includes(c) ? (
                <span className="text-brand text-ui-xs">{d.keyboard.previewYoursStay}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    )
  }
  const ready = choice.layer === 'text' || loaded.status !== 'loading'
  const heading =
    !ready || (choice.layer === 'app' && loaded.status === 'failed')
      ? null
      : count > 0
        ? fmt(d.keyboard.previewTitle, { name, count })
        : fmt(d.keyboard.previewNone, { name })

  return (
    <section
      aria-label={fmt(d.keyboard.previewTitle, { name, count })}
      data-slot="preset-preview"
      className="key-reveal mt-1.5 rounded-md border border-line bg-surface-1 p-2"
    >
      {heading ? <h3 className="mb-1 font-medium text-fg text-ui-sm">{heading}</h3> : null}
      {body}
      <p className="mt-1.5 text-fg-muted text-ui-xs">
        {customNames.length > 0
          ? fmt(d.keyboard.previewKept, { names: customNames.join(d.keyboard.listSeparator) })
          : d.keyboard.previewKeptNone}
      </p>
      <div className="mt-2 flex justify-end gap-1">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          {d.keyboard.cancel}
        </Button>
        <Button size="xs" disabled={!ready} onClick={onApply}>
          {fmt(d.keyboard.apply, { name })}
        </Button>
      </div>
    </section>
  )
}

function ChoiceRow({
  layer,
  label,
  desc,
  options,
  value,
  previewing,
  status,
  onPick,
}: {
  layer: PresetLayer
  label: string
  desc: string
  options: Choice[]
  value: string
  previewing: string | null
  status: JSX.Element
  onPick: (choice: PresetChoice) => void
}): JSX.Element {
  const hit = useSearchLeaf([label, desc])
  return (
    <div
      data-search-hit={hit || undefined}
      className="grid grid-cols-[8rem_1fr_auto] items-start gap-x-3 py-1"
    >
      <span className="pt-1 text-fg text-ui-sm">{label}</span>
      <div className="min-w-0">
        <fieldset aria-label={label} className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
          {options.map((o) => {
            const checked = o.value === value
            const looking = o.value === previewing
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={checked}
                data-previewing={looking || undefined}
                onClick={() => onPick({ layer, value: o.value, label: o.label })}
                className={`h-6 rounded-md border px-2 text-ui-sm outline-none focus-visible:ring-1 focus-visible:ring-brand ${
                  checked
                    ? 'border-line-strong bg-surface-3 text-fg'
                    : looking
                      ? 'border-fg-muted border-dashed text-fg'
                      : 'border-line text-fg-muted hover:bg-surface-2'
                }`}
              >
                {o.label}
              </button>
            )
          })}
        </fieldset>
        <p className="mt-0.5 text-fg-muted text-ui-xs">{desc}</p>
      </div>
      <div className="pt-1 text-right">{status}</div>
    </div>
  )
}

export function KeymapCombo({ onShowChanges }: { onShowChanges: () => void }): JSX.Element {
  const d = useDict()
  const setKeymap = useSettingsStore((s) => s.setKeymap)
  const setTerminalKeymap = useSettingsStore((s) => s.setTerminalKeymap)
  const chosenTerminal = useSettingsStore((s) => s.terminalKeymap)
  const keybindings = useSettingsStore((s) => s.keybindings)
  const terminalKeys = useSettingsStore((s) => s.terminalKeys)
  useSettingsStore((s) => s.keymap)
  const list = useExtensionsStore((s) => s.list)
  const [preview, setPreview] = useState<PresetChoice | null>(null)
  const here = keyboardPlatform(platform)
  const choices = keymapChoices(list, platform)
  const ref = appKeymap()
  const chosen = choices.find((c) => c.ref === ref)
  const loaded = useKeymapStore((s) => (chosen && s.ref === chosen.ref ? s.loaded : null))
  const error = useKeymapStore((s) => (chosen && s.ref === chosen.ref ? s.error : null))
  const terminal = terminalKeymapOf(chosenTerminal, isMac)
  const appOptions = [
    { value: OSTIA_KEYMAP, label: appKeymapLabel(OSTIA_KEYMAP, d) },
    ...choices.map((c) => ({ value: c.ref, label: c.label })),
  ]
  const appValue = appOptions.some((o) => o.value === ref) ? ref : OSTIA_KEYMAP
  const textOptions = terminalKeymapsFor(here).map((k) => ({
    value: k.id,
    label: terminalKeymapLabel(k.id, d),
  }))
  const appDiffer = appPresetChanges(keymapBindings(), isMac).length
  const textDiffer = textPresetChanges(chosenTerminal, isMac).length
  const custom = userChangeCount(userChanges(keybindings, terminalKeys))

  const pick = (choice: PresetChoice): void => {
    const applied = choice.layer === 'app' ? appValue : terminal
    setPreview(choice.value === applied ? null : choice)
  }

  const apply = (): void => {
    if (!preview) return
    if (preview.layer === 'app') setKeymap(preview.value)
    else setTerminalKeymap(preview.value)
    setPreview(null)
  }

  const status = (count: number): JSX.Element =>
    count > 0 ? (
      <Button variant="ghost" size="xs" className="text-fg-muted" onClick={onShowChanges}>
        {count === 1 ? d.keyboard.differOne : fmt(d.keyboard.differ, { count })}
        <CaretRightIcon />
      </Button>
    ) : (
      <span className="text-fg-muted text-ui-xs">{d.keyboard.sameAsDefault}</span>
    )

  return (
    <section
      aria-label={d.keyboard.combo}
      data-slot="keymap-combo"
      className="mb-3 rounded-md border border-line px-3 py-2"
    >
      <h3 className="mb-1 font-medium text-fg-muted text-ui-xs">{d.keyboard.combo}</h3>
      <ChoiceRow
        layer="app"
        label={d.keyboard.keymap}
        desc={d.keyboard.keymapDesc}
        options={appOptions}
        value={appValue}
        previewing={preview?.layer === 'app' ? preview.value : null}
        status={status(appDiffer)}
        onPick={pick}
      />
      {preview?.layer === 'app' ? (
        <PresetPreview choice={preview} onApply={apply} onCancel={() => setPreview(null)} />
      ) : null}
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
      <ChoiceRow
        layer="text"
        label={d.keyboard.terminalKeymap}
        desc={d.keyboard.terminalKeymapDesc}
        options={textOptions}
        value={terminal}
        previewing={preview?.layer === 'text' ? preview.value : null}
        status={status(textDiffer)}
        onPick={pick}
      />
      {preview?.layer === 'text' ? (
        <PresetPreview choice={preview} onApply={apply} onCancel={() => setPreview(null)} />
      ) : null}
      {terminal === NATURAL_TEXT_EDITING ? (
        <WarningNote>{d.keyboard.naturalTextEditingNote}</WarningNote>
      ) : null}
      <p className="mt-1 text-fg-muted text-ui-xs">
        {custom > 0 ? fmt(d.keyboard.comboCustom, { count: custom }) : d.keyboard.comboCustomNone}
      </p>
    </section>
  )
}
