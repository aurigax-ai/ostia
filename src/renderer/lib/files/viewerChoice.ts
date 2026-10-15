import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  type FileViewerPriority,
  OWN_VIEW,
  matchesFilenamePattern,
  viewerMatches,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileViewers'

export interface ViewerOption {
  viewType: string
  displayName: string
  extId: string
  builtin: boolean
  priority: FileViewerPriority
}

export interface ViewerChoiceInput {
  path: string
  options: readonly ViewerOption[]
  chosen?: string
  associations: Readonly<Record<string, string>>
  ownView: boolean
  inArtifacts: boolean
}

export interface ViewerChoice {
  viewer: ViewerOption | null
  unavailable: boolean
}

const OWN: ViewerChoice = { viewer: null, unavailable: false }

export function viewerOptions(
  path: string | undefined,
  extensions: readonly ExtensionInfo[],
): ViewerOption[] {
  if (!path) return []
  const options: ViewerOption[] = []
  const ordered = [...extensions].sort(
    (a, b) => Number(b.builtin) - Number(a.builtin) || a.id.localeCompare(b.id),
  )
  for (const ext of ordered) {
    if (!ext.enabled) continue
    for (const viewer of ext.fileViewers) {
      if (!viewerMatches(path, viewer)) continue
      options.push({
        viewType: viewer.viewType,
        displayName: viewer.displayName,
        extId: ext.id,
        builtin: ext.builtin,
        priority: viewer.priority,
      })
    }
  }
  return options
}

function named(viewType: string, options: readonly ViewerOption[]): ViewerChoice {
  if (viewType === OWN_VIEW) return OWN
  const viewer = options.find((option) => option.viewType === viewType)
  return viewer ? { viewer, unavailable: false } : { viewer: null, unavailable: true }
}

export function associationFor(
  path: string,
  associations: Readonly<Record<string, string>>,
): string | null {
  for (const [pattern, viewType] of Object.entries(associations)) {
    if (matchesFilenamePattern(path, pattern)) return viewType
  }
  return null
}

export function chooseViewer(input: ViewerChoiceInput): ViewerChoice {
  if (input.chosen) return named(input.chosen, input.options)
  const associated = associationFor(input.path, input.associations)
  if (associated) return named(associated, input.options)
  if (input.ownView) return OWN
  const preferred =
    input.options.find((option) => option.priority === 'default') ??
    (input.inArtifacts ? input.options[0] : undefined)
  return preferred ? { viewer: preferred, unavailable: false } : OWN
}

export function associationPattern(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.indexOf('.', 1)
  return dot > 0 ? `*${name.slice(dot).toLowerCase()}` : name
}
