import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

export function freshDataHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pine-e2e-data-'))
  created.push(dir)
  return dir
}

export const DOM_RENDERER_SETTINGS = {
  behavior: { gpuAcceleration: false },
  workspaces: { confirmQuit: false },
}

export function seedSettings(dataHome: string, settings: object): void {
  const userData = join(dataHome, 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
}

const TEST_GITCONFIG = '[user]\n\tname = Pine E2E\n\temail = e2e@example.com\n'

export function testHome(dataHome: string): string {
  const home = join(dataHome, 'home')
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.zshrc'), '')
    writeFileSync(join(home, '.bashrc'), '')
    writeFileSync(join(home, '.gitconfig'), TEST_GITCONFIG)
  }
  return home
}

export function isolatedLaunch(dataHome: string = freshDataHome()): {
  args: string[]
  env: Record<string, string>
  home: string
} {
  if (!existsSync(join(dataHome, 'userData', 'settings.json'))) {
    seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  }
  const { ZDOTDIR: _zdotdir, ...inherited } = process.env as Record<string, string>
  const home = testHome(dataHome)
  return {
    args: [`--user-data-dir=${join(dataHome, 'userData')}`, '.'],
    env: {
      ...inherited,
      NODE_ENV: 'test',
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: join(dataHome, 'config'),
    },
    home,
  }
}

process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})
