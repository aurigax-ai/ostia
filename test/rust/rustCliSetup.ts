import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import buildOnce from '../buildOnce'
import { rustBinary } from './rustApp'

function shim(binary: string): string {
  return [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process')",
    `const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: 'inherit' })`,
    "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))",
    "child.on('exit', (code, signal) => {",
    '  if (signal) process.kill(process.pid, signal)',
    '  else process.exit(code ?? 1)',
    '})',
    '',
  ].join('\n')
}

export default function setup(): void {
  if (process.env.OSTIA_RUST_CLI !== '1') return
  buildOnce()
  const cli = join(process.cwd(), 'out', 'cli', 'index.js')
  writeFileSync(cli, shim(rustBinary('ostia')))
  chmodSync(cli, 0o755)
}
