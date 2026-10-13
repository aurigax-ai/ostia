import { describe, expect, it } from 'vitest'
import { FAKE } from '../../../test/fixtures/secrets/samples'
import {
  DEFAULT_TELEMETRY_SETTINGS,
  type ReportContext,
  TELEMETRY_MESSAGE_MAX,
  type TelemetrySettings,
  anyTelemetryOn,
  bucketCount,
  buildBatch,
  buildErrorReport,
  buildUsageReport,
  emptyUsageCounts,
  parseIngest,
  parseTelemetrySettings,
  reduceStack,
  reportCategories,
  stripPaths,
  withoutCategories,
} from './telemetry'

const ctx: ReportContext = {
  installId: 'install-1',
  context: {
    app_version: '1.2.3',
    electron_version: '33.0.0',
    os_name: 'linux',
    os_version: '6.1',
    arch: 'x64',
    locale: 'en',
    channel: 'packaged',
  },
  now: () => 1_700_000_000_000,
  newId: () => 'event-1',
  redact: (text) => text.replace(/ghp_[A-Za-z0-9]+/g, '[redacted]'),
}

const frame = (rest: object) => ({ platform: 'node', in_app: true, ...rest })
const only = (...on: Array<keyof TelemetrySettings>): TelemetrySettings =>
  Object.fromEntries(
    Object.keys(DEFAULT_TELEMETRY_SETTINGS).map((k) => [k, on.includes(k as never)]),
  ) as TelemetrySettings

describe('parseTelemetrySettings', () => {
  it('has every category off unless it is exactly true', () => {
    expect(parseTelemetrySettings(undefined)).toEqual(DEFAULT_TELEMETRY_SETTINGS)
    expect(anyTelemetryOn(parseTelemetrySettings({ errors: 'yes', usage: 1 }))).toBe(false)
    expect(parseTelemetrySettings({ errors: true, agents: true })).toEqual(only('errors', 'agents'))
  })

  it('leaves a category added later off without any stored value', () => {
    expect(parseTelemetrySettings({ errors: true, usage: true }).terminal).toBe(false)
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
  it('is a $exception event with the install context, paths stripped and secrets redacted', () => {
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
    expect(Object.keys(report.properties).sort()).toEqual([
      '$exception_list',
      '$process_person_profile',
      'app_version',
      'arch',
      'channel',
      'electron_version',
      'locale',
      'os_name',
      'os_version',
      'source',
    ])
    const [entry] = report.properties.$exception_list
    expect(entry.type).toBe('TypeError')
    expect(entry.value).toBe('token [redacted] at <path>')
    expect(entry.stacktrace).toEqual({
      type: 'raw',
      frames: [frame({ function: 'f', filename: 'x.js', lineno: 1, colno: 2 })],
    })
    expect(JSON.stringify(report)).not.toContain('ghp_')
    expect(JSON.stringify(report)).not.toContain('/home')
    expect(reportCategories(report)).toEqual(['errors'])
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
    expect(report.properties.extension).toBe('git')
  })
})

describe('buildUsageReport', () => {
  const counts = () => {
    const c = emptyUsageCounts()
    c.usage = { app_starts: 1, session_minutes: 42, windows: '1', restore: 'ok' }
    c.features = { command: { 'pane.split': 2 }, input_mode: 'editor' }
    c.terminal = { engine: 'ghostty', shell: { zsh: 3 } }
    c.extensions = { installed: ['trellis'], enabled: ['trellis'] }
    c.agents = { session: { claude: 1 }, bus_message: 4 }
    return c
  }

  it('namespaces every property by category and carries only enabled categories', () => {
    const report = buildUsageReport(counts(), only('usage', 'features', 'extensions'), ctx)
    expect(report.event).toBe('usage')
    expect(report.properties).toEqual({
      ...ctx.context,
      $process_person_profile: false,
      'usage.app_starts': 1,
      'usage.session_minutes': 42,
      'usage.windows': '1',
      'usage.restore': 'ok',
      'features.command.pane.split': 2,
      'features.input_mode': 'editor',
      'extensions.installed': ['trellis'],
      'extensions.enabled': ['trellis'],
    })
    expect(JSON.stringify(report.properties)).not.toContain('terminal.')
    expect(JSON.stringify(report.properties)).not.toContain('agents.')
    expect(reportCategories(report)).toEqual(['usage', 'features', 'extensions'])
  })

  it('drops a category that was turned off after the report was queued', () => {
    const report = buildUsageReport(counts(), only('usage', 'agents'), ctx)
    const trimmed = withoutCategories(report, only('agents'))
    expect(trimmed?.properties['agents.bus_message']).toBe(4)
    expect(trimmed?.properties['usage.app_starts']).toBeUndefined()
    expect(withoutCategories(report, only('errors'))).toBeNull()
  })

  it('buckets window and workspace counts', () => {
    expect([0, 1, 2, 3, 4, 7, 8, 40].map(bucketCount)).toEqual([
      '0',
      '1',
      '2-3',
      '2-3',
      '4-7',
      '4-7',
      '8+',
      '8+',
    ])
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
