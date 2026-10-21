import { realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicAsync } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { readRegularFile } from '../../artifacts/previewFiles'
import { claudeConfigFile, editClaudeConfig } from '../claudeFolderTrust'

const SETTINGS_FILE = 'settings.json'
const SETTINGS_READ_MAX = 1024 * 1024
const CONFIG_READ_MAX = 32 * 1024 * 1024

async function copySettings(defaultHome: string, profileDir: string): Promise<void> {
  const target = join(profileDir, SETTINGS_FILE)
  const resolved = await realpath(join(defaultHome, SETTINGS_FILE)).catch((err: unknown) => err)
  if (typeof resolved !== 'string') {
    if ((resolved as NodeJS.ErrnoException).code === 'ENOENT') await rm(target, { force: true })
    return
  }
  const source = await readRegularFile(resolved, SETTINGS_READ_MAX)
  if (!source.ok) return
  const current = await readRegularFile(target, SETTINGS_READ_MAX)
  if (current.ok && current.body.equals(source.body)) return
  await writeFileAtomicAsync(target, source.body.toString('utf8'), { mode: 0o600 })
}

async function defaultMcpServers(): Promise<unknown> {
  const file = await claudeConfigFile(homedir(), process.env.CLAUDE_CONFIG_DIR || undefined)
  const resolved = await realpath(file).catch(() => null)
  const read = resolved ? await readRegularFile(resolved, CONFIG_READ_MAX) : null
  if (!read?.ok) return undefined
  try {
    return (JSON.parse(read.body.toString('utf8')) as { mcpServers?: unknown }).mcpServers ?? null
  } catch {
    return undefined
  }
}

async function copyMcpServers(profileDir: string): Promise<void> {
  const servers = await defaultMcpServers()
  if (servers === undefined) return
  const wanted = JSON.stringify(servers)
  await editClaudeConfig(await claudeConfigFile(homedir(), profileDir), (config) => {
    if (JSON.stringify(config.mcpServers ?? null) === wanted) return null
    const { mcpServers: _old, ...rest } = config
    return servers === null ? rest : { ...rest, mcpServers: servers }
  })
}

export async function syncProfileFromDefault(
  profileDir: string,
  defaultHome: string,
): Promise<void> {
  await Promise.allSettled([copySettings(defaultHome, profileDir), copyMcpServers(profileDir)])
}
