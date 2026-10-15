import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { quoteArg } from '../../shared/terminal/shellQuote'
import { writeFileAtomic } from '../platform/atomicWrite'

export interface KeptLauncherPaths {
  node: string
  cli: string
}

export interface KeptPlumbingOptions {
  launcherDir: string
  execPath: string
  appPath: string
  listen: () => void
  warn: (code: string | null) => void
}

export function keptLauncherPaths(launcherDir: string): KeptLauncherPaths {
  return { node: join(launcherDir, 'ostia-node'), cli: join(launcherDir, 'ostia-cli.js') }
}

function writeKeptLaunchers(launcherDir: string, execPath: string, appPath: string): void {
  const paths = keptLauncherPaths(launcherDir)
  mkdirSync(launcherDir, { recursive: true, mode: 0o700 })
  writeFileAtomic(paths.node, `#!/bin/sh\nexec ${quoteArg(execPath)} "$@"\n`, { mode: 0o700 })
  writeFileAtomic(paths.cli, `require(${JSON.stringify(join(appPath, 'out/cli/index.js'))})\n`, {
    mode: 0o600,
  })
}

export class KeptPlumbing {
  private ready = false

  constructor(private readonly options: KeptPlumbingOptions) {}

  start(keepShells: boolean): void {
    if (keepShells) this.ensure()
  }

  ensure(): void {
    if (this.ready) return
    this.ready = true
    const { launcherDir, execPath, appPath, listen, warn } = this.options
    try {
      writeKeptLaunchers(launcherDir, execPath, appPath)
    } catch (err) {
      warn((err as NodeJS.ErrnoException).code ?? null)
    }
    listen()
  }
}
