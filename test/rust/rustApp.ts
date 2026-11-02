import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

interface SeededPane {
  paneId: string
  externalId: string
  token: string
}

interface SeededExtension {
  extId: string
  externalId: string
  token: string
}

export interface RustApp {
  socket: string
  panes: SeededPane[]
  extensions: SeededExtension[]
  stop: () => Promise<void>
}

export interface RustAppSeed {
  panes?: string[]
  extensions?: string[]
}

export function rustBinary(name: string): string {
  const target = process.env.CARGO_TARGET_DIR ?? join(process.cwd(), 'target')
  return join(process.env.OSTIA_RUST_BIN_DIR ?? join(target, 'debug'), name)
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error('the Rust test app has no stdout'))
      return
    }
    const lines = createInterface({ input: child.stdout })
    lines.once('line', (line) => {
      lines.close()
      resolve(line)
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`the Rust test app exited with ${code}`)))
  })
}

export async function launchRustApp(seed: RustAppSeed = {}): Promise<RustApp> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-rs-')))
  const args = [
    ...(seed.panes ?? []).flatMap((pane) => ['--pane', pane]),
    ...(seed.extensions ?? []).flatMap((extension) => ['--extension', extension]),
  ]
  const child = spawn(rustBinary('ostia-test-app'), args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(dir, 'data'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_RUNTIME_DIR: dir,
      TMPDIR: dir,
    },
  })
  const ready = JSON.parse(await firstLine(child)) as Omit<RustApp, 'stop'>
  return {
    ...ready,
    stop: async () => {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.stdin?.end()
      await exited
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
