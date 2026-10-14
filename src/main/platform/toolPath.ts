import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

export const LOGIN_PATH_TIMEOUT_MS = 5000
const MARK = '__OSTIA_LOGIN_PATH__'

type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>

export interface ToolPathEnv {
  path?: string
  platform?: NodeJS.Platform
  home?: string
}

export interface LoginPathOptions {
  shell?: string
  platform?: NodeJS.Platform
  timeoutMs?: number
  run?: ShellRunner
}

export interface LoginPathResult {
  path: string | null
  ms: number
}

let loginPath = ''
let pending: Promise<LoginPathResult> | null = null

export function fallbackDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
  }
  if (platform === 'linux') {
    return [
      '/usr/local/bin',
      '/usr/local/sbin',
      join(home, '.local', 'bin'),
      '/home/linuxbrew/.linuxbrew/bin',
      '/snap/bin',
    ]
  }
  return []
}

export function mergePaths(...paths: string[]): string {
  const seen = new Set<string>()
  for (const path of paths) {
    for (const dir of path.split(delimiter)) if (dir) seen.add(dir)
  }
  return [...seen].join(delimiter)
}

export function toolPath(env: ToolPathEnv = {}): string {
  const platform = env.platform ?? process.platform
  return mergePaths(
    env.path ?? process.env.PATH ?? '',
    loginPath,
    fallbackDirs(platform, env.home ?? homedir()).join(delimiter),
  )
}

export function parseLoginPath(output: string): string | null {
  const start = output.indexOf(MARK)
  const end = output.lastIndexOf(MARK)
  if (start < 0 || end <= start) return null
  const path = output.slice(start + MARK.length, end).trim()
  if (!path || /[\r\n]/.test(path)) return null
  return path
}

function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL) return env.SHELL
  try {
    if (userInfo().shell) return userInfo().shell as string
  } catch {}
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

const runShell: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((done) => {
    const child = execFile(
      shell,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
      },
      (_err, stdout) => done(stdout ?? ''),
    )
    child.stdin?.end()
  })

export function resolveLoginPath(options: LoginPathOptions = {}): Promise<LoginPathResult> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return Promise.resolve({ path: null, ms: 0 })
  const shell = options.shell ?? loginShell()
  const run = options.run ?? runShell
  const started = Date.now()
  const command = `printf '%s' '${MARK}'; printenv PATH; printf '%s' '${MARK}'`
  pending = run(shell, ['-ilc', command], options.timeoutMs ?? LOGIN_PATH_TIMEOUT_MS)
    .catch(() => '')
    .then((output) => {
      const path = parseLoginPath(output)
      if (path) loginPath = path
      return { path, ms: Date.now() - started }
    })
  return pending
}

export async function loginPathSettled(): Promise<void> {
  await pending
}

export function resetLoginPath(): void {
  loginPath = ''
  pending = null
}
