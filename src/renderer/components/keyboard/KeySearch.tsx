import { KeyboardIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import { type ChordSpec, chordText, overlaps } from '@shared/keyboard/chordSpec'
import { useCallback, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { fmt, useDict } from '@/lib/app/useDict'
import { chordsOf } from '@/lib/keyboard/chords'
import { isMac } from '@/platform'
import { ChordRecorder } from './ChordRecorder'

export function boundTo(id: string, spec: ChordSpec): boolean {
  return chordsOf(id, isMac).some((bound) => overlaps(bound, spec))
}

export function KeySearch({
  query,
  onQuery,
  chord,
  onChord,
}: {
  query: string
  onQuery: (query: string) => void
  chord: ChordSpec | null
  onChord: (chord: ChordSpec | null) => void
}): JSX.Element {
  const d = useDict()
  const [recording, setRecording] = useState(false)
  const stop = useCallback(() => setRecording(false), [])
  const record = useCallback(
    (spec: ChordSpec) => {
      setRecording(false)
      onQuery('')
      onChord(spec)
    },
    [onQuery, onChord],
  )
  const keys = chord ? chordText(chord, isMac) : ''
  return (
    <InputGroup className="h-7 flex-1">
      <InputGroupAddon>
        <MagnifyingGlassIcon />
      </InputGroupAddon>
      {recording ? (
        <div className="flex min-w-0 flex-1 items-center px-2">
          <ChordRecorder label={d.keyboard.searchByKeys} onRecord={record} onCancel={stop} />
        </div>
      ) : chord ? (
        <output
          aria-label={fmt(d.keyboard.searchedKeys, { keys })}
          className="flex min-w-0 flex-1 items-center px-2"
        >
          <Kbd className="text-fg">{keys}</Kbd>
        </output>
      ) : (
        <InputGroupInput
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={d.keyboard.search}
          aria-label={d.keyboard.search}
        />
      )}
      <InputGroupAddon align="inline-end">
        {chord && !recording ? (
          <IconButton
            icon={XIcon}
            label={d.keyboard.clearKeySearch}
            onClick={() => onChord(null)}
          />
        ) : null}
        <IconButton
          icon={KeyboardIcon}
          label={d.keyboard.searchByKeys}
          aria-pressed={recording}
          onClick={() => setRecording((was) => !was)}
        />
      </InputGroupAddon>
    </InputGroup>
  )
}
