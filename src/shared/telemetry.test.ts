import { describe, expect, it } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import {
  type ReportContext,
  TELEMETRY_MESSAGE_MAX,
  buildBatch,
  buildErrorReport,
  buildUsageReport,
  parseIngest,
  parseTelemetrySettings,
  reduceStack,
  stripPaths,
} from './telemetry'

const ctx: ReportContext = {
  installId: 'install-1',
  host: {
    app_version: '1.2.3',
    electron_version: '33.0.0',
    os_name: 'linux',
    os_version: '6.1',
    arch: 'x64',
  },
  now: () => 1_700_000_000_000,
  newId: () => 'event-1',
  redact: (text) => text.replace(/ghp_[A-Za-z0-9]+/g, '[redacted]'),
}

const frame = (rest: object) => ({ platform: 'node', in_app: true, ...rest })

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

describe('parseIngest', () => {
  it('turns the ingest host and project key into the batch url', () => {
    expect(parseIngest('https://us.i.posthog.com', 'phc_abc')).toEqual({
      url: 'https://us.i.posthog.com/batch/',
      apiKey: 'phc_abc',
    })
  })

  it('reads the key from the url for a test override, and refuses the rest', () => {
    expect(parseIngest('http://phc_e2e@127.0.0.1:8000', '')).toEqual({
      url: 'http://127.0.0.1:8000/batch/',
      apiKey: 'phc_e2e',
    })
    expect(parseIngest('', '')).toBeNull()
    expect(parseIngest('', 'phc_abc')).toBeNull()
    expect(parseIngest('https://us.i.posthog.com', '')).toBeNull()
    expect(parseIngest('ftp://k@host', '')).toBeNull()
    expect(parseIngest('https://host/?x=1', 'phc_abc')).toBeNull()
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
      frame({ filename: 'task_queues', lineno: 95, colno: 5 }),
      frame({ function: 'async Object.<anonymous>', filename: 'index.js', lineno: 3, colno: 1 }),
      frame({ function: 'runIt', filename: 'app.js', lineno: 12, colno: 5 }),
    ])
    expect(JSON.stringify(frames)).not.toContain('ann')
  })

  it('answers no frames for a missing stack', () => {
    expect(reduceStack(undefined)).toEqual([])
  })
})

describe('buildErrorReport', () => {
  it('is a $exception event holding only the allowed fields, paths stripped and secrets redacted', () => {
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
      'distinct_id',
      'event',
      'properties',
      'timestamp',
      'uuid',
    ])
    expect(report.event).toBe('$exception')
    expect(report.distinct_id).toBe('install-1')
    expect(report.timestamp).toBe('2023-11-14T22:13:20.000Z')
    expect(Object.keys(report.properties).sort()).toEqual([
      '$exception_list',
      '$process_person_profile',
      'app_version',
      'arch',
      'electron_version',
      'os_name',
      'os_version',
      'source',
    ])
    expect(report.properties.$process_person_profile).toBe(false)
    const [entry] = report.properties.$exception_list
    expect(entry.type).toBe('TypeError')
    expect(entry.value).toBe('token [redacted] at <path>')
    expect(entry.stacktrace).toEqual({
      type: 'raw',
      frames: [frame({ function: 'f', filename: 'x.js', lineno: 1, colno: 2 })],
    })
    expect(JSON.stringify(report)).not.toContain('ghp_')
    expect(JSON.stringify(report)).not.toContain('/home')
    expect(JSON.stringify(report)).not.toContain('$ip')
  })

  it('clips the message and falls back to Error for an odd name', () => {
    const report = buildErrorReport(
      { source: 'renderer-error', name: 'not a name', message: 'x'.repeat(5000) },
      ctx,
    )
    const [entry] = report.properties.$exception_list
    expect(entry.type).toBe('Error')
    expect(entry.value).toHaveLength(TELEMETRY_MESSAGE_MAX)
    expect(entry.stacktrace).toBeUndefined()
  })

  it('names the extension only when given', () => {
    const report = buildErrorReport(
      { source: 'extension-crashed', name: 'ExtensionCrashed', message: 'x', extension: 'git' },
      ctx,
    )
    expect(report.properties.source).toBe('extension-crashed')
    expect(report.properties.extension).toBe('git')
  })
})

describe('buildUsageReport', () => {
  it('is a usage event carrying counts only', () => {
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
    expect(report.event).toBe('usage')
    expect(report.properties).toEqual({
      ...ctx.host,
      $process_person_profile: false,
      app_starts: 1,
      session_minutes: 42,
      commands: { 'pane.split': 2 },
      surfaces: { terminal: 3 },
      settings: { privacy: 1 },
      marketplace_extensions: ['trellis'],
    })
  })
})

describe('buildBatch', () => {
  it('is the capture batch body with the project key and the reports as given', () => {
    const report = buildErrorReport({ source: 'main-exception', name: 'E', message: 'm' }, ctx)
    expect(JSON.parse(buildBatch([report, report], 'phc_abc'))).toEqual({
      api_key: 'phc_abc',
      batch: [report, report],
    })
  })
})
