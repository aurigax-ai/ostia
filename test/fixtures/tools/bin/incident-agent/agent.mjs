import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const ostia = (...args) =>
  spawnSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  })

const swallow = process.env.REPRO_SWALLOW_ENTER === '1'
const neverDone = process.env.REPRO_NEVER_DONE === '1'
const marker = process.env.REPRO_MARKER
const restarted = marker !== undefined && existsSync(marker)
if (marker !== undefined) writeFileSync(marker, 'started')
const silent = restarted && process.env.REPRO_SILENT_WAKE === '1'

if (!silent) {
  ostia('resume-token', 'claude', 'repro-incident')
  if (!neverDone) ostia('state', 'done')
}
process.stdout.write('\x1b[?2004hfake-agent-ready\r\n')
process.stdin.setRawMode(true)
let pending = ''
let afterPaste = false
let swallowed = false
process.stdin.on('data', (chunk) => {
  pending += chunk.toString()
  while (pending) {
    if (pending.startsWith('\x1b[200~')) {
      const end = pending.indexOf('\x1b[201~')
      if (end < 0) return
      process.stdout.write(pending.slice(6, end).replace(/\r/g, '\r\n'))
      pending = pending.slice(end + 6)
      afterPaste = true
      continue
    }
    const key = pending[0]
    pending = pending.slice(1)
    if (key !== '\r') {
      process.stdout.write(key)
      continue
    }
    if (swallow && afterPaste && !swallowed) {
      swallowed = true
      afterPaste = false
      process.stdout.write('\r\nswallowed-enter\r\n')
      continue
    }
    process.stdout.write('\r\nsubmitted\r\n')
    ostia('state', 'working')
    if (!neverDone) setTimeout(() => ostia('state', 'done'), 300)
  }
})
