import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

export function freshDataHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pine-e2e-data-'))
  created.push(dir)
  return dir
}

export function isolatedLaunch(dataHome: string = freshDataHome()): {
  args: string[]
  env: Record<string, string>
} {
  return {
    args: [`--user-data-dir=${join(dataHome, 'userData')}`, '.'],
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: 'test',
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: join(dataHome, 'config'),
    },
  }
}

process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})
