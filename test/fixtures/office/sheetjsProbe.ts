import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface SheetJSProbe {
  largestAllocation: number
  cells: number
  threw: boolean
  crashed: boolean
}

const PROBE = `
const [file, library] = process.argv.slice(1)
const { readFileSync } = await import('node:fs')
const bytes = new Uint8Array(readFileSync(file))
globalThis.Buffer = undefined
let largest = 0
const Native = Uint8Array
globalThis.Uint8Array = new Proxy(Native, {
  construct(target, args, newTarget) {
    if (typeof args[0] === 'number') largest = Math.max(largest, args[0])
    return Reflect.construct(target, args, newTarget)
  },
})
const XLSX = await import(library)
let cells = 0
let threw = false
try {
  const book = XLSX.read(bytes, {
    type: 'array',
    dense: true,
    cellFormula: true,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
    sheetRows: 100001,
  })
  for (const name of book.SheetNames) {
    for (const row of book.Sheets[name]['!data'] ?? []) {
      if (row) for (const cell of row) if (cell) cells++
    }
  }
} catch {
  threw = true
}
process.stdout.write(JSON.stringify({ largestAllocation: largest, cells, threw }))
`

export function probeSheetJS(bytes: Uint8Array, heapMb = 512): SheetJSProbe {
  const dir = mkdtempSync(join(tmpdir(), 'sheetjs-probe-'))
  const file = join(dir, 'input')
  writeFileSync(file, bytes)
  const library = pathToFileURL(join(process.cwd(), 'node_modules/xlsx/xlsx.mjs')).href
  try {
    const run = spawnSync(
      process.execPath,
      [`--max-old-space-size=${heapMb}`, '--input-type=module', '-e', PROBE, file, library],
      { encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH ?? '' } },
    )
    if (run.status !== 0 || !run.stdout) {
      return { largestAllocation: 0, cells: 0, threw: true, crashed: true }
    }
    return { ...(JSON.parse(run.stdout) as Omit<SheetJSProbe, 'crashed'>), crashed: false }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
