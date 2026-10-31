import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'

const run = promisify(execFile)
const QUERY_TIMEOUT_MS = 3000

export interface HandlerLookup {
  platform: NodeJS.Platform
  protocolApp: (url: string) => string
  queryDefault: (scheme: string) => Promise<string>
  readDesktop: (file: string) => Promise<string | null>
}

export function desktopName(entry: string): string | null {
  let inEntry = false
  for (const line of entry.split(/\r?\n/)) {
    const section = /^\[(.+)\]\s*$/.exec(line)
    if (section) inEntry = section[1] === 'Desktop Entry'
    else if (inEntry && line.startsWith('Name=')) return line.slice(5).trim() || null
  }
  return null
}

export async function handlerName(url: string, lookup: HandlerLookup): Promise<string | null> {
  if (lookup.platform !== 'linux') return lookup.protocolApp(url) || null
  const scheme = new URL(url).protocol.slice(0, -1)
  const file = (await lookup.queryDefault(scheme)).trim()
  if (!file.endsWith('.desktop') || file.includes('/')) return null
  const entry = await lookup.readDesktop(file)
  return (entry && desktopName(entry)) || file.slice(0, -'.desktop'.length)
}

function applicationDirs(env: NodeJS.ProcessEnv): string[] {
  const data = env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [data, ...dirs].map((dir) => join(dir, 'applications'))
}

export function systemHandlerLookup(): HandlerLookup {
  return {
    platform: process.platform,
    protocolApp: (url) => app.getApplicationNameForProtocol(url),
    queryDefault: async (scheme) => {
      try {
        const { stdout } = await run(
          'xdg-mime',
          ['query', 'default', `x-scheme-handler/${scheme}`],
          {
            timeout: QUERY_TIMEOUT_MS,
          },
        )
        return stdout
      } catch {
        return ''
      }
    },
    readDesktop: async (file) => {
      for (const dir of applicationDirs(process.env)) {
        try {
          return await readFile(join(dir, file), 'utf8')
        } catch {}
      }
      return null
    },
  }
}
