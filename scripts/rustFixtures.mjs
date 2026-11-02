import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const out = join(root, 'test/fixtures/rust')
const work = mkdtempSync(join(tmpdir(), 'rust-fixtures-'))

const ENTRY = `
export { ParkedStore } from './src/main/park/parkedStore'
export { saveJson, saveJsonAsync } from './src/main/platform/jsonStore'
export * as bus from './src/main/agents/busStore'
`

const bundle = join(work, 'bundle.cjs')
await build({
  stdin: { contents: ENTRY, resolveDir: root, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'error',
})
const { ParkedStore, saveJson, saveJsonAsync, bus } = createRequire(import.meta.url)(bundle)

const STORE_VALUE = {
  v: 1,
  text: 'é 日本語 😀 "quoted" back\\slash   \u001b tab\t',
  count: 1700000000123,
  fraction: 1.5,
  negative: -7,
  flag: true,
  none: null,
  empty: [],
  blank: {},
  z: { b: [1, [2, { deep: 'x' }]], a: 'keeps the order' },
}

mkdirSync(out, { recursive: true })
saveJson(join(out, 'json-store-pretty.json'), STORE_VALUE)
await saveJsonAsync(join(out, 'json-store-compact.json'), STORE_VALUE)

const NUMBER_TEXTS = [
  '',
  ' ',
  '\t\n',
  '12',
  '12abc',
  '1.5',
  ' 1.5\n',
  '0x10',
  '0X1f',
  '0o17',
  '0O17',
  '0b101',
  '0B11',
  '-0x10',
  '+0x10',
  '0x',
  '0o8',
  '0b2',
  '0xg',
  '1e3',
  '1E3',
  '1e-3',
  '1e+3',
  '1e',
  '1e+',
  'e5',
  '.5',
  '5.',
  '5.e3',
  '.e3',
  '.',
  '-.5',
  '+.5',
  '-',
  '+',
  '+5',
  '-5',
  '-0',
  '0',
  '00012',
  '--5',
  '+-5',
  'Infinity',
  '+Infinity',
  '-Infinity',
  'infinity',
  'INFINITY',
  'inf',
  'nan',
  'NaN',
  '1_000',
  '1,000',
  '1 2',
  '1.5.2',
  '1d',
  '1f',
  '0x1p3',
  '١٢',
  ' 12﻿',
  '\u008512',
  '​12',
  ' 1 ',
  '9007199254740991',
  '9007199254740992',
  '9007199254740993',
  '9007199254740995',
  '18446744073709551616',
  '123456789012345678901234567890',
  '1e999',
  '-1e999',
  '1e-999',
  '0.1',
  '0.30000000000000004',
  '1.7976931348623157e308',
  '5e-324',
  '2.2250738585072014e-308',
  '0x1fffffffffffff',
  '0x20000000000001',
  '0x20000000000003',
  '0x20000000000005',
  '0x100000000000008000000000000000001',
  '0xffffffffffffffffffffffffffffffffffffffff',
  '0x000000000000000000000000000000000000000000000001',
  `0x${'f'.repeat(300)}`,
  `0b${'1'.repeat(60)}`,
]

function float64Hex(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeDoubleBE(value)
  return buffer.toString('hex')
}

writeFileSync(
  join(out, 'js-number.json'),
  `${JSON.stringify(
    NUMBER_TEXTS.map((text) => ({ text, bits: float64Hex(Number(text)) })),
    null,
    1,
  )}\n`,
)

const times = [1700000000123, 9, 1.5]
const parked = join(work, 'parked-sessions.json')
const store = new ParkedStore(parked, () => times.shift())
store.park({
  workspaceId: 'w1',
  resume: { agent: 'claude', id: 's1', cwd: '/home/u/api', args: ['--model', 'opus'] },
  title: 'export é',
  titlePinned: true,
  summary: 'stopped at the retry test',
})
const gone = store.park({ workspaceId: 'w1', resume: { agent: 'codex', id: 's2' }, title: 'gone' })
store.park({ workspaceId: 'w2', resume: { agent: 'agy', id: 's3' }, title: 'third' })
writeFileSync(join(out, 'parked-sessions-before.json'), readFileSync(parked))
store.remove(gone.record.id)
writeFileSync(join(out, 'parked-sessions-after.json'), readFileSync(parked))

const BUS_FIXED_MS = Date.parse('2026-10-18T10:00:00.000Z')
const RealDate = Date
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length > 0 ? args : [BUS_FIXED_MS]))
  }

  static now() {
    return BUS_FIXED_MS
  }
}
const busFile = join(work, 'bus.json')
bus.setBusPath(busFile)
bus.enqueue({ id: 'm1', from: 'a', to: 'b', text: 'build é green\nsecond line' })
bus.enqueue({
  id: 'm2',
  from: 'a',
  to: 'c',
  text: 'do the task',
  task: true,
  wakes: true,
  route: 'remote:h',
  origin: 'remote:h',
})
bus.enqueue({ id: 'm3', from: 'a', to: 'd', text: 'read me' })
const handed = bus.leaseMail('d', 'read', () => true)
bus.ackMail('d', handed.lease)
bus.enqueue({ id: 'm4', from: 'a', to: 'e', text: 'lost' })
bus.failPaneMail('e')
bus.watchPane('boss', 'w1', ['done', 'command'])
bus.claimWake('ext-1', BUS_FIXED_MS, 3, 60_000)
await bus.flushBus()
writeFileSync(join(out, 'bus-before.json'), readFileSync(busFile))
bus.dismissFailed('e')
await bus.flushBus()
writeFileSync(join(out, 'bus-after.json'), readFileSync(busFile))
globalThis.Date = RealDate
rmSync(work, { recursive: true, force: true })
