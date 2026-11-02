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
const { ParkedStore, saveJson, saveJsonAsync } = createRequire(import.meta.url)(bundle)

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
rmSync(work, { recursive: true, force: true })
