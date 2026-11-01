import { type ChordSpec, chordText } from '@shared/keyboard/chordSpec'
import { type JSX, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { SelectField } from '@/components/settingsKit/SelectField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { fmt, useDict } from '@/lib/app/useDict'
import {
  actionSend,
  SEND_ACTION_KEYS,
  type SendActionKey,
  sendActionKey,
} from '@/lib/keyboard/actionSends'
import { chordsWithoutKey, terminalKeyConflicts } from '@/lib/keyboard/chords'
import { saveTerminalKey, type TerminalKeyRow, terminalKeyFor } from '@/lib/keyboard/keyPresets'
import {
  sendChordProblem,
  sendData,
  TERMINAL_SEND_TYPES,
  type TerminalSend,
  type TerminalSendType,
} from '@/lib/keyboard/terminalKeys'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { ChordRecorder } from './ChordRecorder'
import { commandTitle, problemText, sendText } from './keyboardLabels'
import { keepChords } from './keyRows'

interface Replacing {
  commands: string[]
  existing: TerminalKeyRow | null
}

const CUSTOM_SEND = 'custom'

type SendChoice = SendActionKey | typeof CUSTOM_SEND

export function TerminalKeyEditor({
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
        <CustomSendFields
          type={type}
          value={value}
          onType={(v) => {
            setType(v)
            setReplacing(null)
          }}
          onValue={(v) => {
            setValue(v)
            setReplacing(null)
          }}
        />
      ) : null}
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {replacing?.commands.map((id) => (
        <Notice key={id}>{fmt(d.keyboard.conflict, { keys, command: commandTitle(id, d) })}</Notice>
      ))}
      {replacing?.existing ? (
        <Notice>
          {fmt(d.keyboard.sendConflict, { keys, send: sendText(replacing.existing.send) })}
        </Notice>
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

function CustomSendFields({
  type,
  value,
  onType,
  onValue,
}: {
  type: TerminalSendType
  value: string
  onType: (type: TerminalSendType) => void
  onValue: (value: string) => void
}): JSX.Element {
  const d = useDict()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SelectField
        label={d.keyboard.sendType}
        value={type}
        onChange={onType}
        options={TERMINAL_SEND_TYPES.map((t) => ({ value: t, label: d.keyboard.sendTypes[t] }))}
        width="w-fit min-w-36"
      />
      <Input
        value={value}
        aria-label={d.keyboard.sendValue}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onValue(e.target.value)}
        className="h-7 w-56 font-mono text-ui-sm"
      />
    </div>
  )
}
