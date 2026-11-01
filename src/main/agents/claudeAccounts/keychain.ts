import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'

const SERVICE = 'Claude Code-credentials'
const NOT_FOUND = 44
const ACCOUNT_SHAPE = /^[a-zA-Z0-9._-]+$/
const FALLBACK_ACCOUNT = 'claude-code-user'
const TIMEOUT_MS = 5000
const STDIN_LINE_MAX = 4032

export function keychainService(configDir: string): string {
  const digest = createHash('sha256').update(configDir.normalize('NFC')).digest('hex')
  return `${SERVICE}-${digest.slice(0, 8)}`
}

export function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  let name: string
  try {
    name = env.USER || userInfo().username
  } catch {
    return FALLBACK_ACCOUNT
  }
  return ACCOUNT_SHAPE.test(name) ? name : FALLBACK_ACCOUNT
}

interface SecurityResult {
  code: number | null
  stdout: string
}

function security(args: string[], input?: string): Promise<SecurityResult> {
  return new Promise((resolve) => {
    const child = spawn('security', args, { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

export async function readKeychain(configDir: string): Promise<Record<string, unknown> | null> {
  const { code, stdout } = await security([
    'find-generic-password',
    '-a',
    keychainAccount(),
    '-w',
    '-s',
    keychainService(configDir),
  ])
  if (code === NOT_FOUND) return {}
  if (code !== 0) return null
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export async function writeKeychain(
  configDir: string,
  credentials: Record<string, unknown>,
): Promise<boolean> {
  const hex = Buffer.from(JSON.stringify(credentials), 'utf8').toString('hex')
  const command = `add-generic-password -U -a "${keychainAccount()}" -s "${keychainService(configDir)}" -X "${hex}"\n`
  if (command.length > STDIN_LINE_MAX) return false
  const { code } = await security(['-i'], command)
  return code === 0
}

export async function forgetKeychain(configDir: string): Promise<void> {
  await security([
    'delete-generic-password',
    '-a',
    keychainAccount(),
    '-s',
    keychainService(configDir),
  ])
}
