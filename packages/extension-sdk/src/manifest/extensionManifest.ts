import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_PLUGIN_CAPABILITY } from '../contract/agentPlugins'
import { parseEditorLanguages } from '../contract/editorLanguages'
import { apiProblem, parseApiVersion } from '../contract/extensionApi'
import {
  EXTENSION_CATEGORIES,
  EXTENSION_MANIFEST_FILE,
  type ExtensionCategory,
  type ExtensionManifest,
} from '../contract/extensions'
import { parseFileKinds } from '../contract/fileKinds'
import { isRecord } from '../contract/isRecord'
import { parseLanguageServers } from '../contract/languageServerManifest'
import { isInsideDir } from './confinedRead'
import { parseConnectionKinds } from './connectionKinds'
import { isCoreSource, verbProblem } from './coreNames'
import { isOlderVersion } from './extensionVersions'
import {
  parseAgentHooks,
  parseAgentSkills,
  parseAssist,
  parseChips,
  parseCommands,
  parseIconThemes,
  parseKeymaps,
  parseLanguages,
  parseLocales,
  parsePanel,
  parseSnippets,
} from './manifestContributions'
import { capabilities, EXTENSION_ID_PATTERN, MAX_DESCRIPTION, text } from './manifestFields'
import { parseSecrets, parseSettings, parseSettingsPage } from './manifestSettings'

export type ManifestResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; error: string }

export interface DiscoveredExtension {
  dir: string
  builtin: boolean
  manifest: ExtensionManifest
}

export interface ExtensionRoot {
  dir: string
  builtin: boolean
}

export interface ManifestOptions {
  anyApi?: boolean
}

export function parseManifest(
  raw: unknown,
  dir: string,
  options: ManifestOptions = {},
): ManifestResult {
  if (!isRecord(raw)) return { ok: false, error: 'manifest must be a JSON object' }
  const id = raw.id
  if (typeof id !== 'string' || !EXTENSION_ID_PATTERN.test(id)) {
    return { ok: false, error: 'invalid id (lowercase letters, digits, dashes)' }
  }
  if (isCoreSource(id)) return { ok: false, error: `id '${id}' is a built-in feature` }
  const name = text(raw.name)
  const version = text(raw.version, 40)
  if (!name) return { ok: false, error: 'missing name' }
  if (!version) return { ok: false, error: 'missing version' }
  if (raw.api === undefined) return { ok: false, error: 'missing api' }
  const incompatible = options.anyApi && parseApiVersion(raw.api) ? null : apiProblem(raw.api)
  if (incompatible) return { ok: false, error: incompatible }
  const description =
    typeof raw.description === 'string' ? raw.description.slice(0, MAX_DESCRIPTION) : ''
  const caps = capabilities(raw.capabilities, 'manifest')
  if (typeof caps === 'string') return { ok: false, error: caps }
  const category = raw.category === undefined ? 'other' : raw.category
  if (!EXTENSION_CATEGORIES.includes(category as ExtensionCategory)) {
    return { ok: false, error: `category must be one of ${EXTENSION_CATEGORIES.join(', ')}` }
  }

  let main: string | undefined
  if (raw.main !== undefined) {
    if (typeof raw.main !== 'string' || !isInsideDir(dir, raw.main)) {
      return { ok: false, error: 'main must be a path inside the extension' }
    }
    main = raw.main
  }

  const contributes = raw.contributes === undefined ? {} : raw.contributes
  if (!isRecord(contributes)) return { ok: false, error: 'contributes must be an object' }
  const commands = parseCommands(contributes.commands)
  if (typeof commands === 'string') return { ok: false, error: commands }
  const panel = parsePanel(contributes.panel, dir)
  if (typeof panel === 'string') return { ok: false, error: panel }
  const snippets = parseSnippets(contributes.snippets)
  if (typeof snippets === 'string') return { ok: false, error: snippets }
  const completions = contributes.completions
  if (
    completions !== undefined &&
    (typeof completions !== 'string' || !isInsideDir(dir, completions))
  ) {
    return { ok: false, error: 'contributes.completions must be a folder inside the extension' }
  }
  const sidebarItems = contributes.sidebarItems === true
  const paneChips = parseChips(contributes.paneChips, 'paneChips')
  if (typeof paneChips === 'string') return { ok: false, error: paneChips }
  const workspaceChips = parseChips(contributes.workspaceChips, 'workspaceChips')
  if (typeof workspaceChips === 'string') return { ok: false, error: workspaceChips }
  const settings = parseSettings(contributes.settings)
  if (typeof settings === 'string') return { ok: false, error: settings }
  const secrets = parseSecrets(contributes.secrets)
  if (typeof secrets === 'string') return { ok: false, error: secrets }
  const connections = parseConnectionKinds(contributes.connections)
  if (typeof connections === 'string') return { ok: false, error: connections }
  const assist = parseAssist(contributes.assist, caps)
  if (typeof assist === 'string') return { ok: false, error: assist }
  const settingsPage = parseSettingsPage(
    contributes.settingsPage,
    settings.length > 0 || secrets.length > 0 || connections.length > 0,
    assist.length > 0,
  )
  if (typeof settingsPage === 'string') return { ok: false, error: settingsPage }
  const iconThemes = parseIconThemes(contributes.iconThemes, dir)
  if (typeof iconThemes === 'string') return { ok: false, error: iconThemes }
  const languages = parseLanguages(contributes.languages, dir)
  if (typeof languages === 'string') return { ok: false, error: languages }
  const keymaps = parseKeymaps(contributes.keymaps, dir)
  if (typeof keymaps === 'string') return { ok: false, error: keymaps }
  const locales = parseLocales(raw.locales)
  if (typeof locales === 'string') return { ok: false, error: locales }
  const languageServers = parseLanguageServers(contributes.languageServers, {
    isInside: (path) => isInsideDir(dir, path),
    capabilities: caps,
    settingKeys: settings.map((setting) => setting.key),
  })
  if (typeof languageServers === 'string') return { ok: false, error: languageServers }
  const editorLanguages = parseEditorLanguages(contributes.editorLanguages, (path) =>
    isInsideDir(dir, path),
  )
  if (typeof editorLanguages === 'string') return { ok: false, error: editorLanguages }
  const fileKinds = parseFileKinds(contributes.fileKinds, id, {
    isInside: (path) => isInsideDir(dir, path),
    main: Boolean(main),
    capabilities: caps,
  })
  if (typeof fileKinds === 'string') return { ok: false, error: fileKinds }
  const agentSkills = parseAgentSkills(contributes.agentSkills, dir)
  if (typeof agentSkills === 'string') return { ok: false, error: agentSkills }
  const agentHooks = parseAgentHooks(contributes.agentHooks, commands)
  if (typeof agentHooks === 'string') return { ok: false, error: agentHooks }
  if (
    (agentSkills.length > 0 || agentHooks.length > 0) &&
    !caps.includes(AGENT_PLUGIN_CAPABILITY)
  ) {
    return {
      ok: false,
      error: `contributes.agentSkills and agentHooks need the '${AGENT_PLUGIN_CAPABILITY}' capability`,
    }
  }
  if (contributes.verb !== undefined) {
    const problem = verbProblem(contributes.verb)
    if (problem) return { ok: false, error: problem }
  }
  const needsMain =
    commands.length > 0 ||
    sidebarItems ||
    panel?.entry === 'url' ||
    paneChips.length > 0 ||
    workspaceChips.length > 0 ||
    assist.length > 0
  if (needsMain && !main) {
    return {
      ok: false,
      error: 'commands, sidebar items, chips, assist and url panels need a main process',
    }
  }

  const manifest: ExtensionManifest = {
    id,
    name,
    version,
    api: raw.api as string,
    description,
    category: category as ExtensionCategory,
    capabilities: caps,
    contributes: { commands, sidebarItems, paneChips, workspaceChips, settings, assist, secrets },
  }
  if (main) manifest.main = main
  if (locales.length > 0) manifest.locales = locales
  if (panel) manifest.contributes.panel = panel
  if (settingsPage) manifest.contributes.settingsPage = settingsPage
  if (connections.length > 0) manifest.contributes.connections = connections
  if (snippets && snippets.length > 0) manifest.contributes.snippets = snippets
  if (completions !== undefined) manifest.contributes.completions = completions
  if (iconThemes.length > 0) manifest.contributes.iconThemes = iconThemes
  if (languages.length > 0) manifest.contributes.languages = languages
  if (keymaps.length > 0) manifest.contributes.keymaps = keymaps
  if (languageServers.length > 0) manifest.contributes.languageServers = languageServers
  if (editorLanguages.length > 0) manifest.contributes.editorLanguages = editorLanguages
  if (fileKinds.length > 0) manifest.contributes.fileKinds = fileKinds
  if (agentSkills.length > 0) manifest.contributes.agentSkills = agentSkills
  if (agentHooks.length > 0) manifest.contributes.agentHooks = agentHooks
  if (typeof contributes.verb === 'string') manifest.contributes.verb = contributes.verb
  return { ok: true, manifest }
}

export function readManifest(dir: string, options: ManifestOptions = {}): ManifestResult {
  const file = EXTENSION_MANIFEST_FILE
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  } catch (err) {
    return { ok: false, error: `unreadable ${file}: ${(err as Error).message}` }
  }
  return parseManifest(raw, dir, options)
}

function subdirs(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .sort()
      .map((name) => join(root, name))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory() && existsSync(join(dir, EXTENSION_MANIFEST_FILE))
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

function verbClash(manifest: ExtensionManifest, found: DiscoveredExtension[]): string | null {
  const words = (m: ExtensionManifest): string[] => [
    m.id,
    ...(m.contributes.verb ? [m.contributes.verb] : []),
  ]
  const mine = manifest.contributes.verb
  for (const other of found) {
    const taken = words(other.manifest)
    if (mine && mine !== manifest.id && taken.includes(mine)) {
      return `contributes.verb '${mine}' is already the id or verb of '${other.manifest.id}'`
    }
    if (other.manifest.contributes.verb === manifest.id) {
      return `id '${manifest.id}' is already the verb of '${other.manifest.id}'`
    }
  }
  return null
}

function updateProblem(bundled: ExtensionManifest, update: ExtensionManifest): string | null {
  return isOlderVersion(update.version, bundled.version)
    ? `version ${update.version} is below the bundled ${bundled.version}`
    : null
}

export type OfficialUpdateCheck = (dir: string, manifest: ExtensionManifest) => string | null

export function discoverExtensions(
  roots: ExtensionRoot[],
  onError: (dir: string, error: string) => void = () => {},
  officialUpdate: OfficialUpdateCheck = () => 'no official update channel',
): DiscoveredExtension[] {
  const found = new Map<string, DiscoveredExtension>()
  const ordered = [...roots].sort((a, b) => Number(b.builtin) - Number(a.builtin))
  for (const root of ordered) {
    for (const dir of subdirs(root.dir)) {
      const res = readManifest(dir)
      if (!res.ok) {
        onError(dir, res.error)
        continue
      }
      const bundled = found.get(res.manifest.id)
      if (bundled?.builtin && !root.builtin) {
        const problem =
          officialUpdate(dir, res.manifest) ?? updateProblem(bundled.manifest, res.manifest)
        if (problem)
          onError(dir, `not used in place of the built-in '${bundled.manifest.id}': ${problem}`)
        else found.set(bundled.manifest.id, { dir, builtin: true, manifest: res.manifest })
        continue
      }
      if (bundled) {
        onError(dir, `duplicate extension id '${res.manifest.id}'`)
        continue
      }
      const clash = verbClash(
        res.manifest,
        [...found.values()].filter((e) => e.builtin || !root.builtin),
      )
      if (clash) {
        onError(dir, clash)
        continue
      }
      if (root.builtin) {
        for (const [id, other] of found) {
          if (
            !other.builtin &&
            verbClash(other.manifest, [{ dir, builtin: true, manifest: res.manifest }])
          ) {
            onError(other.dir, `'${id}' gives way to the built-in '${res.manifest.id}'`)
            found.delete(id)
          }
        }
      }
      found.set(res.manifest.id, { dir, builtin: root.builtin, manifest: res.manifest })
    }
  }
  return [...found.values()]
}
