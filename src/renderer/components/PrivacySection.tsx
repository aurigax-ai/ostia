import { XIcon } from '@phosphor-icons/react'
import {
  CUSTOM_KIND,
  type PatternProblem,
  REDACTION_PATTERNS_MAX,
  REDACTION_PATTERN_MAX,
  REDACTION_REPEAT_MAX,
  type RedactionKindInfo,
  type RedactionResult,
  patternProblem,
  placeholderFor,
} from '@shared/redaction'
import { useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { redactedCountLabel } from '../lib/chatRedaction'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { SectionHead, SettingsGroup, ToggleRow, WarningNote } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

const PREVIEW_DEBOUNCE_MS = 250

function problemText(d: Dict, problem: PatternProblem): string {
  const max = problem === 'wide-repeat' ? REDACTION_REPEAT_MAX : REDACTION_PATTERN_MAX
  return fmt(d.privacy.problems[problem], { max })
}

function KindList({ kinds }: { kinds: RedactionKindInfo[] }): JSX.Element {
  const d = useDict()
  const ownLabels = d.privacy.kinds as Record<string, string>
  const library = kinds.filter((k) => k.source === 'library')
  const own = [...kinds.filter((k) => k.source === 'pine').map((k) => k.kind), CUSTOM_KIND]
  return (
    <SettingsGroup title={d.privacy.groupKinds} desc={d.privacy.kindsDesc}>
      {library.length > 0 ? (
        <>
          <h4 className="mt-1 mb-1.5 font-medium text-fg text-ui-sm">{d.privacy.libraryKinds}</h4>
          <ul aria-label={d.privacy.libraryKinds} className="flex flex-wrap gap-1.5">
            {library.map((info) => (
              <li key={info.kind}>
                <Badge
                  variant="outline"
                  className="font-mono text-ui-xs"
                  title={info.detects.join(', ')}
                >
                  {info.kind}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4 className="mt-3 mb-1.5 font-medium text-fg text-ui-sm">{d.privacy.ownKinds}</h4>
      <ul aria-label={d.privacy.ownKinds} className="flex flex-col gap-1">
        {own.map((kind) => (
          <li key={kind} className="flex items-baseline gap-2 text-ui-sm">
            <Badge variant="outline" className="shrink-0 font-mono text-ui-xs">
              {kind}
            </Badge>
            <span className="text-fg-muted">{ownLabels[kind] ?? ''}</span>
          </li>
        ))}
      </ul>
    </SettingsGroup>
  )
}

function Patterns({ onChanged }: { onChanged: () => void }): JSX.Element {
  const d = useDict()
  const patterns = useSettingsStore((s) => s.privacy.redaction.patterns)
  const setRedaction = useSettingsStore((s) => s.setRedaction)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async (next: string[]): Promise<void> => {
    await setRedaction({ patterns: next })
    onChanged()
  }
  const add = (): void => {
    const problem = patternProblem(draft)
    if (problem) {
      setError(problemText(d, problem))
      return
    }
    if (patterns.includes(draft)) {
      setError(d.privacy.duplicate)
      return
    }
    if (patterns.length >= REDACTION_PATTERNS_MAX) {
      setError(fmt(d.privacy.tooMany, { max: REDACTION_PATTERNS_MAX }))
      return
    }
    setDraft('')
    setError(null)
    void save([...patterns, draft])
  }
  return (
    <SettingsGroup title={d.privacy.groupPatterns} desc={d.privacy.patternsDesc}>
      {patterns.length === 0 ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{d.privacy.noPatterns}</p>
      ) : (
        <ul aria-label={d.privacy.groupPatterns} className="flex flex-col">
          {patterns.map((pattern) => {
            const problem = patternProblem(pattern)
            return (
              <li key={pattern} className="py-1">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">
                    {pattern}
                  </span>
                  <IconButton
                    icon={XIcon}
                    label={fmt(d.privacy.removePattern, { pattern })}
                    onClick={() => void save(patterns.filter((p) => p !== pattern))}
                  />
                </div>
                {problem ? (
                  <WarningNote>
                    {fmt(d.privacy.ignored, { problem: problemText(d, problem) })}
                  </WarningNote>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center gap-3 pt-2">
        <Input
          value={draft}
          spellCheck={false}
          placeholder={d.privacy.pattern}
          aria-label={d.privacy.pattern}
          aria-invalid={error !== null}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          className="h-7 flex-1 font-mono"
        />
        <Button variant="outline" size="sm" onClick={add}>
          {d.privacy.addPattern}
        </Button>
      </div>
      {error ? <WarningNote>{error}</WarningNote> : null}
    </SettingsGroup>
  )
}

function TestBox({ revision }: { revision: number }): JSX.Element {
  const d = useDict()
  const [text, setText] = useState('')
  const [result, setResult] = useState<RedactionResult | null>(null)
  useEffect(() => {
    void revision
    if (text === '') {
      setResult(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      window.pine.privacy
        .preview(text)
        .then((next) => {
          if (!stale) setResult(next)
        })
        .catch(() => {
          if (!stale) setResult(null)
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [text, revision])
  return (
    <SettingsGroup title={d.privacy.groupTest} desc={d.privacy.testDesc}>
      <Textarea
        rows={4}
        value={text}
        spellCheck={false}
        aria-label={d.privacy.testInput}
        placeholder={d.privacy.testInput}
        className="font-mono text-ui-sm"
        onChange={(e) => setText(e.target.value)}
      />
      {result ? (
        <div className="mt-2" aria-live="polite">
          {result.count === 0 ? (
            <p className="text-fg-muted text-ui-sm">{d.privacy.testNone}</p>
          ) : (
            <>
              <p className="mb-1 flex flex-wrap items-center gap-1.5 text-fg text-ui-sm">
                <span>{redactedCountLabel(d, result.count)}</span>
                {Object.entries(result.kinds).map(([kind, count]) => (
                  <Badge key={kind} variant="outline" className="font-mono text-ui-xs">
                    {count > 1 ? `${placeholderFor(kind)} × ${count}` : placeholderFor(kind)}
                  </Badge>
                ))}
              </p>
              <pre
                aria-label={d.privacy.testOutput}
                className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-2 font-mono text-fg text-ui-sm"
              >
                {result.text}
              </pre>
            </>
          )}
        </div>
      ) : null}
    </SettingsGroup>
  )
}

export function PrivacySection(): JSX.Element {
  const d = useDict()
  const enabled = useSettingsStore((s) => s.privacy.redaction.enabled)
  const setRedaction = useSettingsStore((s) => s.setRedaction)
  const [kinds, setKinds] = useState<RedactionKindInfo[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stale = false
    window.pine.privacy
      .kinds()
      .then((next) => {
        if (!stale) setKinds(next)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])
  return (
    <div>
      <SectionHead title={d.privacy.title} desc={d.privacy.desc} />
      <SettingsGroup title={d.privacy.groupRedaction}>
        <ToggleRow
          label={d.privacy.enabled}
          desc={d.privacy.enabledDesc}
          checked={enabled}
          onChange={(on) => void setRedaction({ enabled: on })}
        />
      </SettingsGroup>
      <KindList kinds={kinds} />
      <Patterns onChanged={() => setRevision((n) => n + 1)} />
      <TestBox revision={revision} />
    </div>
  )
}
