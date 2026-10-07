import { describe, expect, it } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import {
  type ReportContext,
  TELEMETRY_MESSAGE_MAX,
  authHeader,
  buildEnvelope,
  buildErrorReport,
  buildUsageReport,
  parseDsn,
  parseTelemetrySettings,
  reduceStack,
  stripPaths,
} from './telemetry'

const ctx: ReportContext = {
  installId: 'install-1',
  version: '1.2.3',
  contexts: {
    app: { app_version: '1.2.3' },
    os: { name: 'linux', version: '6.1' },
    device: { arch: 'x64' },
    runtime: { name: 'electron', version: '33.0.0' },
  },
  now: () => 1_700_000_000_000,
  newId: () => 'event-1',
  redact: (text) => text.replace(/ghp_[A-Za-z0-9]+/g, '[redacted]'),
}

describe('parseTelemetrySettings', () => {
  it('is off unless each switch is exactly true', () => {
    expect(parseTelemetrySettings(undefined)).toEqual({ errors: false, usage: false })
    expect(parseTelemetrySettings({ errors: 'yes', usage: 1 })).toEqual({
      errors: false,
      usage: false,
    })
    expect(parseTelemetrySettings({ errors: true })).toEqual({ errors: true, usage: false })
  })
})

describe('parseDsn', () => {
  it('turns a Sentry DSN into the envelope url and the public key', () => {
    expect(parseDsn('https://abc123@glitchtip.example.com/4')).toEqual({
      url: 'https://glitchtip.example.com/api/4/envelope/',
      publicKey: 'abc123',
    })
    expect(parseDsn('http://k@127.0.0.1:8000/prefix/12')).toEqual({
      url: 'http://127.0.0.1:8000/prefix/api/12/envelope/',
      publicKey: 'k',
    })
  })

  it('refuses an empty, keyless, non-http or project-less DSN', () => {
    expect(parseDsn('')).toBeNull()
    expect(parseDsn('https://glitchtip.example.com/4')).toBeNull()
    expect(parseDsn('ftp://k@host/4')).toBeNull()
    expect(parseDsn('https://k@host/')).toBeNull()
    expect(parseDsn('https://k@host/abc')).toBeNull()
  })
})

describe('stripPaths', () => {
  it('replaces absolute, home and Windows paths and file urls, keeping other text', () => {
    expect(stripPaths("ENOENT: open '/home/ann/secret notes/x.txt'")).toBe("ENOENT: open '<path>'")
    expect(stripPaths('read ~/.ssh/id_rsa failed')).toBe('read <path> failed')
    expect(stripPaths('at C:\\Users\\ann\\app.js')).toBe('at <path>')
    expect(stripPaths('file:///home/ann/app/out/main.js failed')).toBe('<path> failed')
    expect(stripPaths('ratio 1/2 and a/b stay')).toBe('ratio 1/2 and a/b stay')
  })
})

describe('reduceStack', () => {
  it('keeps function names, file names and positions, never directories', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at runIt (/home/ann/.local/share/ostia/app/out/main/chunks/app.js:12:5)',
      '    at async Object.<anonymous> (file:///home/ann/proj/out/main/index.js:3:1)',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n')
    const frames = reduceStack(stack)
    expect(frames).toEqual([
      { filename: 'task_queues', lineno: 95, colno: 5 },
      { function: 'async Object.<anonymous>', filename: 'index.js', lineno: 3, colno: 1 },
      { function: 'runIt', filename: 'app.js', lineno: 12, colno: 5 },
    ])
    expect(JSON.stringify(frames)).not.toContain('ann')
  })

  it('answers no frames for a missing stack', () => {
    expect(reduceStack(undefined)).toEqual([])
  })
})

describe('buildErrorReport', () => {
  it('holds only the allowed fields, with paths stripped and secrets redacted', () => {
    const report = buildErrorReport(
      {
        source: 'main-exception',
        name: 'TypeError',
        message: `token ${FAKE.githubClassic} at /home/ann/x.js`,
        stack: 'TypeError: boom\n    at f (/home/ann/x.js:1:2)',
      },
      ctx,
    )
    expect(Object.keys(report).sort()).toEqual([
      'contexts',
      'event_id',
      'exception',
      'level',
      'platform',
      'release',
      'tags',
      'timestamp',
      'user',
    ])
    expect(report.user).toEqual({ id: 'install-1' })
    expect(report.exception.values[0].type).toBe('TypeError')
    expect(report.exception.values[0].value).toBe('token [redacted] at <path>')
    expect(report.exception.values[0].stacktrace?.frames).toEqual([
      { function: 'f', filename: 'x.js', lineno: 1, colno: 2 },
    ])
    expect(JSON.stringify(report)).not.toContain('ghp_')
    expect(JSON.stringify(report)).not.toContain('/home')
  })

  it('clips the message and falls back to Error for an odd name', () => {
    const report = buildErrorReport(
      { source: 'renderer-error', name: 'not a name', message: 'x'.repeat(5000) },
      ctx,
    )
    expect(report.exception.values[0].type).toBe('Error')
    expect(report.exception.values[0].value).toHaveLength(TELEMETRY_MESSAGE_MAX)
    expect(report.exception.values[0].stacktrace).toBeUndefined()
  })

  it('names the extension only when given', () => {
    const report = buildErrorReport(
      { source: 'extension-crashed', name: 'ExtensionCrashed', message: 'x', extension: 'git' },
      ctx,
    )
    expect(report.tags).toEqual({ source: 'extension-crashed', extension: 'git' })
  })
})

describe('buildUsageReport', () => {
  it('is an info event named usage carrying counts only', () => {
    const report = buildUsageReport(
      {
        sessionMinutes: 42,
        commands: { 'pane.split': 2 },
        surfaces: { terminal: 3 },
        settings: { privacy: 1 },
        marketplaceExtensions: ['trellis'],
      },
      ctx,
    )
    expect(report.level).toBe('info')
    expect(report.message).toBe('usage')
    expect(report.tags).toEqual({ app_starts: '1', session_minutes: '42' })
    expect(report.extra).toEqual({
      commands: { 'pane.split': 2 },
      surfaces: { terminal: 3 },
      settings: { privacy: 1 },
      marketplace_extensions: ['trellis'],
    })
  })
})

describe('buildEnvelope', () => {
  it('writes one envelope header and one event item per report', () => {
    const report = buildErrorReport({ source: 'main-exception', name: 'E', message: 'm' }, ctx)
    const lines = buildEnvelope([report, report], 1_700_000_000_000).split('\n')
    expect(JSON.parse(lines[0])).toEqual({ sent_at: '2023-11-14T22:13:20.000Z' })
    const item = JSON.parse(lines[1])
    expect(item.type).toBe('event')
    expect(item.length).toBe(Buffer.byteLength(lines[2]))
    expect(JSON.parse(lines[2])).toEqual(report)
    expect(JSON.parse(lines[3]).type).toBe('event')
    expect(lines).toHaveLength(6)
  })

  it('builds the Sentry auth header without a secret key', () => {
    expect(authHeader('pub', 'ostia/1.0.0')).toBe(
      'Sentry sentry_version=7, sentry_key=pub, sentry_client=ostia/1.0.0',
    )
  })
})
