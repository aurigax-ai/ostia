import type { CommandSuggestion } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { type JSX, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { useDict } from '@/lib/app/useDict'
import { latestRequest } from '@/lib/assist/assistComposer'
import { insertCommand } from '@/lib/terminal/blockActions'
import { platform } from '@/platform'
import { useAssistComposerStore } from '@/stores/assist/assistComposerStore'
import { assistRequest, useAssistProvider } from '@/stores/assist/assistStore'
import { ComposerFrame, failureText, RedactedNote, type Status, StatusLine } from './ComposerFrame'

const COMMAND_DEBOUNCE_MS = 500
export function ShellComposer({
  paneId,
  cwd,
  onClose,
}: {
  paneId: string
  cwd?: string
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const provider = useAssistProvider('command')
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ for: string; suggestions: CommandSuggestion[] } | null>(
    null,
  )
  const [index, setIndex] = useState(0)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const pending = useRef(latestRequest())

  useEffect(() => {
    areaRef.current?.focus()
    const request = pending.current
    return () => request.cancel()
  }, [])

  const ask = (query: string, delayMs: number): void => {
    if (!query.trim()) {
      pending.current.cancel()
      setStatus({ kind: 'idle' })
      return
    }
    pending.current.run(async (signal) => {
      setStatus({ kind: 'busy' })
      const res = await assistRequest(
        'command',
        { query, ...(cwd ? { cwd } : {}), platform },
        { signal },
      )
      if (signal.aborted) return
      if (!res.ok) {
        const message = failureText(d, res)
        setStatus(message ? { kind: 'error', text: message } : { kind: 'idle' })
        return
      }
      setIndex(0)
      setResult({ for: query, suggestions: res.result.suggestions })
      setStatus(
        res.result.suggestions.length === 0
          ? { kind: 'note', text: d.assist.noSuggestions }
          : { kind: 'idle' },
      )
    }, delayMs)
  }

  const suggestions = result && result.for === text ? result.suggestions : []

  const insert = (suggestion: CommandSuggestion): void => {
    if (insertCommand(paneId, suggestion.command)) {
      useAssistComposerStore.getState().close()
      return
    }
    setStatus({ kind: 'error', text: d.assist.notAtPrompt })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length > 0) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setIndex((i) => (i + step + suggestions.length) % suggestions.length)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const chosen = suggestions[index]
      if (chosen) insert(chosen)
      else ask(text, 0)
    }
  }

  return (
    <ComposerFrame title={d.assist.shellTitle} provider={provider} onClose={onClose}>
      <Textarea
        ref={areaRef}
        rows={1}
        value={text}
        aria-label={d.assist.shellTitle}
        placeholder={d.assist.shellPlaceholder}
        className="assist-composer-area"
        onChange={(e) => {
          setText(e.target.value)
          ask(e.target.value, COMMAND_DEBOUNCE_MS)
        }}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 ? (
        <Command
          shouldFilter={false}
          value={suggestions[index]?.command}
          onValueChange={(value) => {
            const at = suggestions.findIndex((s) => s.command === value)
            if (at >= 0) setIndex(at)
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="h-auto bg-transparent"
        >
          <CommandList label={d.assist.suggestions} className="assist-composer-list">
            {suggestions.map((s) => (
              <CommandItem
                key={s.command}
                value={s.command}
                className="assist-composer-item"
                onSelect={() => insert(s)}
              >
                <code className="assist-composer-command">{s.command}</code>
                {s.description ? (
                  <span className="truncate text-fg-muted text-ui-xs">{s.description}</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      ) : null}
      <footer className="assist-composer-foot">
        <StatusLine status={status} />
        <RedactedNote text={text} />
        {suggestions.length > 0 ? (
          <span className="ml-auto flex items-center gap-1 text-fg-muted">
            {d.assist.insert}
            <Kbd>↵</Kbd>
          </span>
        ) : null}
      </footer>
    </ComposerFrame>
  )
}
