import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created: string[] = []

export function dataHomeBase(platform: NodeJS.Platform, tmp: string): string {
  return platform === 'darwin' ? '/tmp' : tmp
}

export function freshDataHome(): string {
  const dir = realpathSync(
    mkdtempSync(join(dataHomeBase(process.platform, tmpdir()), 'ostia-e2e-data-')),
  )
  created.push(dir)
  return dir
}

export const SOFTWARE_WEBGL = process.env.OSTIA_E2E_GL_ARG ?? '--enable-unsafe-swiftshader'

export const CANVAS_RENDERER_SETTINGS = {
  behavior: { gpuAcceleration: false },
  workspaces: { confirmQuit: false },
}

export const HIBERNATE_FAST = { enabled: true, idleSeconds: 5, maxLiveTerminals: 0 }

export function seedSettings(dataHome: string, settings: object): void {
  const userData = join(dataHome, 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
}

function seedTelemetryAnswered(dataHome: string): void {
  const userData = join(dataHome, 'userData')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'telemetry.json'), JSON.stringify({ asked: true }))
}

const TEST_ZSHRC = "PROMPT='%~ ❯ '\n"
const TEST_BASHRC = "PS1='\\w ❯ '\n"
const TEST_GITCONFIG = '[user]\n\tname = Ostia E2E\n\temail = e2e@example.com\n'

export function testHome(dataHome: string): string {
  const home = join(dataHome, 'home')
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.zshrc'), TEST_ZSHRC)
    writeFileSync(join(home, '.bashrc'), TEST_BASHRC)
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
    seedSettings(dataHome, CANVAS_RENDERER_SETTINGS)
  }
  if (!existsSync(join(dataHome, 'userData', 'telemetry.json'))) seedTelemetryAnswered(dataHome)
  const { ZDOTDIR: _zdotdir, ...inherited } = process.env as Record<string, string>
  const home = testHome(dataHome)
  const runtimeDir = join(dataHome, 'run')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  return {
    args: [`--user-data-dir=${join(dataHome, 'userData')}`, '.'],
    env: {
      ...inherited,
      NODE_ENV: 'test',
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: join(dataHome, 'config'),
      XDG_STATE_HOME: join(dataHome, 'state'),
      XDG_RUNTIME_DIR: runtimeDir,
      ...(process.platform === 'darwin' ? { TMPDIR: runtimeDir } : {}),
    },
    home,
  }
}

export function wireDataDir(
  dataHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'darwin'
    ? join(dataHome, 'home', 'Library', 'Application Support', 'wire')
    : join(dataHome, 'state', 'wire')
}

function stopWireRuntime(dataHome: string): void {
  try {
    const pid = Number(readFileSync(join(wireDataDir(dataHome), 'runtime.lock'), 'utf8').trim())
    if (pid > 0) process.kill(pid, 'SIGKILL')
  } catch {}
}

process.on('exit', () => {
  for (const dir of created) {
    stopWireRuntime(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})
