import { languageForPath } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  kindMatches,
  matchesFilenamePattern,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import {
  EXTENSION_SUGGESTIONS,
  type ExtensionSuggestion,
  filesLabel,
  suggestedExtension,
} from '../../../shared/extensions/extensionSuggestions'
import type { LanguageServerSource } from '../../lsp/serverBinaries'
import { loadJson, saveJson } from '../../platform/jsonStore'
import type { ExtensionListing } from './marketplace'

const MAX_DISMISSED = 500
const EXTENSION_ID = /^[a-z][a-z0-9-]{1,39}$/

export interface SuggestionSources {
  servers: () => LanguageServerSource[]
  extensions: () => Pick<ExtensionInfo, 'id' | 'name' | 'enabled' | 'status' | 'fileKinds'>[]
  listings: () => ExtensionListing[]
  dismissed: () => readonly string[]
  official: string
  languageOf?: (path: string) => string
}

interface Candidate {
  extId: string
  files: string
  feature: ExtensionSuggestion['feature']
}

function viewed(path: string, extensions: ReturnType<SuggestionSources['extensions']>): boolean {
  return extensions.some(
    (ext) => ext.enabled && ext.fileKinds.some((kind) => kind.approved && kindMatches(path, kind)),
  )
}

function awaitsApproval(
  path: string,
  ext: ReturnType<SuggestionSources['extensions']>[number],
): boolean {
  return (
    ext.status === 'pending-approval' ||
    ext.fileKinds.some((kind) => !kind.approved && kindMatches(path, kind))
  )
}

export function suggestionFor(
  path: string,
  sources: SuggestionSources,
): ExtensionSuggestion | null {
  const language = (sources.languageOf ?? languageForPath)(path)
  const servers = sources.servers()
  const covers = (source: LanguageServerSource): boolean =>
    source.server.languages.includes(language)
  if (servers.some((source) => source.state === 'on' && covers(source))) return null
  const extensions = sources.extensions()
  const dismissed = sources.dismissed()
  const files = filesLabel(path)
  const candidates: Candidate[] = []
  const add = (extId: string, label: string, feature: Candidate['feature'] = 'language'): void => {
    if (dismissed.includes(extId) || candidates.some((c) => c.extId === extId)) return
    const installed = extensions.find((ext) => ext.id === extId)
    if (feature === 'language' && installed?.enabled && installed.status !== 'pending-approval') {
      return
    }
    candidates.push({ extId, files: label, feature })
  }
  const fromTable = suggestedExtension(path)
  if (fromTable) add(fromTable.extId, fromTable.files)
  for (const source of servers) if (covers(source)) add(source.extId, files)
  const trusted = sources
    .listings()
    .filter(
      (listing) =>
        listing.marketplaceId === sources.official ||
        !Object.hasOwn(EXTENSION_SUGGESTIONS, listing.extId),
    )
  for (const listing of trusted) {
    if (listing.languages.includes(language)) add(listing.extId, files)
  }
  if (!viewed(path, extensions)) {
    for (const ext of extensions) {
      if (ext.fileKinds.some((kind) => kindMatches(path, kind))) add(ext.id, files, 'view')
    }
    for (const listing of trusted) {
      if (listing.patterns.some((pattern) => matchesFilenamePattern(path, pattern))) {
        add(listing.extId, files, 'view')
      }
    }
  }
  const [first] = candidates
  if (!first) return null
  const others = candidates.length - 1
  const installed = extensions.find((ext) => ext.id === first.extId)
  if (installed) {
    return {
      kind: 'enable',
      extId: first.extId,
      name: installed.name,
      files: first.files,
      pending: awaitsApproval(path, installed),
      feature: first.feature,
      others,
    }
  }
  const listing = trusted.find((l) => l.extId === first.extId)
  return {
    kind: 'install',
    extId: first.extId,
    name: listing?.name ?? first.extId,
    files: first.files,
    feature: first.feature,
    others,
  }
}

export class DismissedSuggestions {
  private ids: string[]

  constructor(private readonly path: string) {
    const raw = loadJson<unknown>(path, {})
    const list = (raw as { dismissed?: unknown } | null)?.dismissed
    this.ids = Array.isArray(list)
      ? list.filter((id): id is string => typeof id === 'string' && EXTENSION_ID.test(id))
      : []
  }

  list(): readonly string[] {
    return this.ids
  }

  dismiss(extId: unknown): void {
    if (typeof extId !== 'string' || !EXTENSION_ID.test(extId) || this.ids.includes(extId)) return
    this.ids = [...this.ids, extId].slice(-MAX_DISMISSED)
    saveJson(this.path, { dismissed: this.ids })
  }
}
