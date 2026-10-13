import { describe, expect, it } from 'vitest'
import { FAKE, HARMLESS } from '../../../test/fixtures/secrets/samples'
import {
  CUSTOM_WINDOW,
  CUSTOM_WINDOW_STEP,
  REDACTION_PATTERNS_MAX,
  REDACTION_PATTERN_MAX,
  applyRedactions,
  compilePatterns,
  countPlaceholders,
  customSpans,
  extraSpans,
  parsePrivacySettings,
  parseRedactionSettings,
  patternProblem,
} from './redaction'
import { DEFAULT_TELEMETRY_SETTINGS } from './telemetry'

function redactExtras(text: string): string {
  return applyRedactions(text, extraSpans(text)).text
}

describe('parseRedactionSettings', () => {
  it('is on with no patterns when nothing is stored', () => {
    expect(parsePrivacySettings(undefined)).toEqual({
      redaction: { enabled: true, patterns: [] },
      telemetry: DEFAULT_TELEMETRY_SETTINGS,
    })
  })

  it('turns off only on an explicit false', () => {
    expect(parseRedactionSettings({ enabled: false }).enabled).toBe(false)
    expect(parseRedactionSettings({ enabled: 'no' }).enabled).toBe(true)
  })

  it('keeps string patterns once each, up to the cap', () => {
    const many = Array.from({ length: REDACTION_PATTERNS_MAX + 5 }, (_, i) => `p${i}`)
    expect(parseRedactionSettings({ patterns: ['a', 7, '', 'a', 'b'] }).patterns).toEqual([
      'a',
      'b',
    ])
    expect(parseRedactionSettings({ patterns: many }).patterns).toHaveLength(REDACTION_PATTERNS_MAX)
  })
})

describe('patternProblem', () => {
  it('accepts a token shape with a counted repeat and one open-ended repeat', () => {
    expect(patternProblem('ACME-[A-Za-z0-9]{32}')).toBeNull()
    expect(patternProblem('corp_(?:live|test)_[0-9a-f]+')).toBeNull()
    expect(patternProblem('(?:[0-9a-f]{4}-){3}[0-9a-f]{4}')).toBeNull()
  })

  it('refuses empty, too long and invalid patterns', () => {
    expect(patternProblem('  ')).toBe('empty')
    expect(patternProblem('a'.repeat(REDACTION_PATTERN_MAX + 1))).toBe('too-long')
    expect(patternProblem('ACME-[')).toBe('invalid')
    expect(patternProblem('a)b')).toBe('invalid')
  })

  it('refuses a pattern that matches empty text', () => {
    expect(patternProblem('a*')).toBe('matches-empty')
    expect(patternProblem('x?')).toBe('matches-empty')
  })

  it('refuses a repeated group that itself repeats or branches', () => {
    expect(patternProblem('(a+)+b')).toBe('nested-repeat')
    expect(patternProblem('(?:a|ab)*c')).toBe('nested-repeat')
    expect(patternProblem('(x[0-9]{1,3}){2}y')).toBe('nested-repeat')
  })

  it('refuses more than one open-ended repeat and a very wide counted one', () => {
    expect(patternProblem('key-\\w+-\\w+')).toBe('open-repeats')
    expect(patternProblem('key-[a-z]{1,5000}')).toBe('wide-repeat')
  })

  it('refuses lookaround and backreferences', () => {
    expect(patternProblem('(?=abc)abc')).toBe('lookaround')
    expect(patternProblem('(?<!x)abc')).toBe('lookaround')
    expect(patternProblem('(a)\\1')).toBe('backreference')
  })

  it('does not read a quantifier inside a character class or after an escape', () => {
    expect(patternProblem('id[+*]{2}[a-z]+')).toBeNull()
    expect(patternProblem('a\\+b\\*c[0-9]+')).toBeNull()
  })
})

describe('customSpans', () => {
  it('finds every match of a valid pattern and skips invalid ones', () => {
    const regexes = compilePatterns(['ACME-[0-9]{4}', '(a+)+b', 'ACME-['])
    expect(regexes).toHaveLength(1)
    const text = 'one ACME-1234\ntwo ACME-9876 end'
    expect(customSpans(text, regexes).map((s) => text.slice(s.start, s.end))).toEqual([
      'ACME-1234',
      'ACME-9876',
    ])
  })

  it('never matches across a line break', () => {
    const regexes = compilePatterns(['BEGIN[\\s\\S]{1,40}END'])
    expect(customSpans('BEGIN a\nEND', regexes)).toEqual([])
    expect(customSpans('BEGIN a END', regexes)).toHaveLength(1)
  })

  it('reads a very long line in overlapping windows, so a match on a window edge is found', () => {
    const regexes = compilePatterns(['ACME-[0-9]{4}'])
    for (const before of [CUSTOM_WINDOW - 4, CUSTOM_WINDOW + 10, CUSTOM_WINDOW * 3 - 2]) {
      const line = `${'x'.repeat(before)}ACME-1234 tail`
      const found = applyRedactions(line, customSpans(line, regexes))
      expect(found.text).toBe(`${'x'.repeat(before)}[redacted:custom] tail`)
      expect(found.count).toBe(1)
    }
  })

  it('misses a match longer than half a window in a very long line', () => {
    const regexes = compilePatterns(['K(?:7{100}){3}'])
    const secret = `K${'7'.repeat(300)}`
    expect(secret.length).toBeGreaterThan(CUSTOM_WINDOW_STEP)
    expect(customSpans(`short ${secret}`, regexes)).toHaveLength(1)
    const line = `${'x'.repeat(CUSTOM_WINDOW_STEP - 16)}${secret}${'x'.repeat(CUSTOM_WINDOW)}`
    expect(customSpans(line, regexes)).toEqual([])
  })
})

describe('extraSpans', () => {
  it('redacts a JSON Web Token', () => {
    expect(redactExtras(`token ${FAKE.jwt} end`)).toBe('token [redacted:jwt] end')
  })

  it('leaves base64 JSON without the three dotted parts alone', () => {
    const text = 'eyJmb28iOiJiYXIiLCJiYXoiOjF9 and eyJhbGciOiJIUzI1NiJ9.short.x'
    expect(redactExtras(text)).toBe(text)
  })

  it('redacts a Google API key and not a longer run that only contains its prefix', () => {
    expect(redactExtras(`key=${FAKE.googleApiKey}`)).toBe('key=[redacted:google-api-key]')
    const longer = `x${FAKE.googleApiKey}y${FAKE.googleApiKey}`
    expect(redactExtras(longer)).toBe(longer)
  })

  it('redacts the credential of an Authorization header and keeps the scheme', () => {
    expect(redactExtras(`curl -H "Authorization: Bearer ${FAKE.bearer}" https://x`)).toBe(
      'curl -H "Authorization: Bearer [redacted:authorization]" https://x',
    )
    expect(redactExtras('authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      'authorization: Basic [redacted:authorization]',
    )
  })

  it('leaves a bearer mention with no header alone', () => {
    const text = 'Send it as a Bearer token in the Authorization header.'
    expect(redactExtras(text)).toBe(text)
  })

  it('redacts only the value of a NAME=value assignment with a secret-like name', () => {
    expect(redactExtras('export DB_PASSWORD=hunter2hunter2 && run')).toBe(
      'export DB_PASSWORD=[redacted:assignment] && run',
    )
    expect(redactExtras('curl "https://x/y?access_token=abc123def456&page=2"')).toBe(
      'curl "https://x/y?access_token=[redacted:assignment]&page=2"',
    )
    expect(redactExtras('--api-key=abcdef123456 --verbose')).toBe(
      '--api-key=[redacted:assignment] --verbose',
    )
  })

  it('redacts a quoted value after : or = with a secret-like name', () => {
    expect(redactExtras('{"api_key": "abcd1234efgh5678", "name": "demo"}')).toBe(
      '{"api_key": "[redacted:assignment]", "name": "demo"}',
    )
    expect(redactExtras("client_secret = 'correct horse battery'")).toBe(
      "client_secret = '[redacted:assignment]'",
    )
  })

  it('leaves code, types, numbers, variables and placeholders alone', () => {
    for (const text of [
      'password: string',
      'const token = getToken()',
      'function login(password, token) {}',
      'max_tokens=100000',
      'PASSWORD=$DB_PASSWORD',
      'TOKEN=${{ secrets.TOKEN }}',
      'token=<your-token>',
      'secret=null',
      'tokenType: "Bearer"',
      'api_key=""',
      HARMLESS.prose,
    ]) {
      expect(redactExtras(text)).toBe(text)
    }
  })

  it('does not swallow a terminal color sequence after the value', () => {
    expect(redactExtras('TOKEN=abcdef123456\x1b[0m next')).toBe(
      'TOKEN=[redacted:assignment]\x1b[0m next',
    )
  })

  it('leaves hashes, UUIDs, long paths and base64 blobs alone', () => {
    for (const text of Object.values(HARMLESS)) expect(redactExtras(text)).toBe(text)
  })
})

describe('applyRedactions', () => {
  it('replaces each span and counts by kind', () => {
    const result = applyRedactions('a SECRET b OTHER c', [
      { start: 2, end: 8, kind: 'one' },
      { start: 11, end: 16, kind: 'two' },
    ])
    expect(result).toEqual({
      text: 'a [redacted:one] b [redacted:two] c',
      count: 2,
      kinds: { one: 1, two: 1 },
    })
  })

  it('merges overlapping spans into one replacement named by the first', () => {
    const result = applyRedactions('0123456789', [
      { start: 4, end: 9, kind: 'late' },
      { start: 2, end: 6, kind: 'early' },
    ])
    expect(result.text).toBe('01[redacted:early]9')
    expect(result.count).toBe(1)
  })

  it('returns the same text when nothing was found', () => {
    expect(applyRedactions('plain', [])).toEqual({ text: 'plain', count: 0, kinds: {} })
  })

  it('never redacts an existing placeholder again', () => {
    const text = 'TOKEN="[redacted:github]" and [redacted:jwt]'
    expect(applyRedactions(text, [{ start: 0, end: text.length, kind: 'custom' }]).text).toBe(
      '[redacted:custom][redacted:github][redacted:custom][redacted:jwt]',
    )
    expect(redactExtras(redactExtras(`password="${FAKE.bearer}"`))).toBe(
      'password="[redacted:assignment]"',
    )
  })

  it('drops spans that fall outside the text', () => {
    expect(applyRedactions('abc', [{ start: 2, end: 9, kind: 'x' }]).text).toBe('abc')
  })
})

describe('countPlaceholders', () => {
  it('counts the redaction marks in a text', () => {
    expect(countPlaceholders('a [redacted:github] b [redacted:custom] [redacted]')).toBe(2)
  })
})
