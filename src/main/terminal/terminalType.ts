import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { appEnv, type EnvSource, withoutEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { agentHooksEnv } from '../../shared/agents/agentHooks'
import { ARTIFACTS_ENV, PAD_ENV, PAD_FILE } from '../../shared/artifacts/artifacts'
import { withoutGpuLaunchEnv } from '../platform/discreteGpu'
import { withLauncherOnPath } from './paneLauncher'

export const PTY_TERM_NAME = 'xterm-256color'

export const PTY_COLOR_ENV = { COLORTERM: 'truecolor' }

export function ptyIdentityEnv(version: string): Record<string, string> {
  return { TERM_PROGRAM: 'ostia', TERM_PROGRAM_VERSION: version }
}

export function ptyHyperlinkEnv(parent: EnvSource): Record<string, string> {
  return parent.FORCE_HYPERLINK === undefined ? { FORCE_HYPERLINK: '1' } : {}
}

const LOCALE_ENV_NAMES = ['LANG', 'LC_ALL', 'LC_CTYPE']

const DEFAULT_REGIONS: Record<string, string> = {
  ar: 'SA',
  cs: 'CZ',
  da: 'DK',
  de: 'DE',
  el: 'GR',
  en: 'US',
  es: 'ES',
  fi: 'FI',
  fr: 'FR',
  he: 'IL',
  hi: 'IN',
  hu: 'HU',
  it: 'IT',
  ja: 'JP',
  ko: 'KR',
  nb: 'NO',
  nl: 'NL',
  pl: 'PL',
  pt: 'BR',
  ro: 'RO',
  ru: 'RU',
  sv: 'SE',
  tr: 'TR',
  uk: 'UA',
  zh: 'CN',
}

const CHINESE_SCRIPT_REGIONS: Record<string, string> = { hant: 'TW', hans: 'CN' }

const FALLBACK_LANG = 'en_US.UTF-8'

function localeCandidates(locale: string | undefined): string[] {
  const parts = (locale ?? '').split('.')[0].split('@')[0].split(/[-_]/).filter(Boolean)
  const language = parts[0]?.toLowerCase()
  if (!language || !/^[a-z]{2,3}$/.test(language)) return []
  const region = parts
    .slice(1)
    .find((part) => /^[A-Za-z]{2}$/.test(part))
    ?.toUpperCase()
  const script = parts
    .slice(1)
    .find((part) => /^[A-Za-z]{4}$/.test(part))
    ?.toLowerCase()
  const scriptRegion = language === 'zh' && script ? CHINESE_SCRIPT_REGIONS[script] : undefined
  const regions = [region, scriptRegion, DEFAULT_REGIONS[language]].filter(
    (value, index, all): value is string => !!value && all.indexOf(value) === index,
  )
  return regions.map((value) => `${language}_${value}.UTF-8`)
}

function normalizeLocaleName(name: string): string {
  return name.toLowerCase().replace('utf-8', 'utf8')
}

let installedLocales: Set<string> | null | undefined

function listInstalledLocales(): Set<string> | null {
  if (installedLocales !== undefined) return installedLocales
  try {
    const out = execFileSync('locale', ['-a'], { encoding: 'utf8', timeout: 2000 })
    installedLocales = new Set(out.split('\n').map((line) => normalizeLocaleName(line.trim())))
  } catch {
    installedLocales = null
  }
  return installedLocales
}

function systemHasLocale(name: string): boolean {
  if (process.platform === 'darwin') return existsSync(join('/usr/share/locale', name))
  const installed = listInstalledLocales()
  return installed ? installed.has(normalizeLocaleName(name)) : true
}

export function ptyLocaleEnv(
  parent: EnvSource,
  locale: string | undefined,
  hasLocale: (name: string) => boolean = systemHasLocale,
): Record<string, string> {
  if (LOCALE_ENV_NAMES.some((name) => parent[name])) return {}
  const lang = [...localeCandidates(locale), FALLBACK_LANG, 'C.UTF-8'].find(hasLocale)
  return { LANG: lang ?? FALLBACK_LANG }
}

export interface PaneShellEnvParts {
  version: string
  locale?: string
  hasLocale?: (name: string) => boolean
  parent: NodeJS.ProcessEnv
  integration: Record<string, string>
  pane: Record<string, string>
  agentHooks: unknown
  artifactsDir?: string | null
  workspaceDir?: string | null
  launcherDir?: string
}

const WORKSPACE_DIR_ENV = 'WORKSPACE_DIR'

function artifactsEnv(dir: string | null | undefined): Record<string, string> {
  return dir ? appEnv({ [ARTIFACTS_ENV]: dir, [PAD_ENV]: join(dir, PAD_FILE) }) : {}
}

export function paneShellEnv(parts: PaneShellEnvParts): Record<string, string> {
  const env = {
    ...withoutEnv(withoutGpuLaunchEnv(parts.parent), [ARTIFACTS_ENV, PAD_ENV, WORKSPACE_DIR_ENV]),
    ...parts.integration,
    ...parts.pane,
    ...artifactsEnv(parts.artifactsDir),
    ...(parts.workspaceDir ? appEnv({ [WORKSPACE_DIR_ENV]: parts.workspaceDir }) : {}),
    ...agentHooksEnv(parts.agentHooks),
    ...ptyLocaleEnv(parts.parent, parts.locale, parts.hasLocale),
    ...ptyHyperlinkEnv(parts.parent),
    ...PTY_COLOR_ENV,
    ...ptyIdentityEnv(parts.version),
  } as Record<string, string>
  return parts.launcherDir ? withLauncherOnPath(env, parts.launcherDir, delimiter) : env
}

export function withPaneToken(
  env: Record<string, string>,
  token: string,
  tokenFile: string | null,
): Record<string, string> {
  return {
    ...(withoutEnv(env, ['TOKEN', 'TOKEN_FILE']) as Record<string, string>),
    ...appEnv(tokenFile ? { TOKEN_FILE: tokenFile } : { TOKEN: token }),
  }
}
