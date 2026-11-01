import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { Icon as IconComponent } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import type { ExtensionAnchor } from '@/components/extensions/InstalledExtensions'
import { createSearchStore, type SearchStore } from '@/components/settingsKit/SettingsSearch'
import { countUsage } from '@/lib/app/usageCounts'
import { extensionMatchesQuery } from '@/lib/extensions/extensionSettingText'
import {
  EXTENSIONS_NAV_EXPANDED_KEY,
  navExpanded,
  rememberNavExpanded,
  SANDBOX_NAV_EXPANDED_KEY,
} from '@/lib/settings/settingsNav'
import { matchesQuery } from '@/lib/settings/settingsSearch'
import {
  extensionPageResultId,
  type SectionId,
  type SettingsSection,
} from '@/lib/settings/settingsSections'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'

const SANDBOX_DEFAULTS_ITEM = ''

export interface NavChild {
  id: string
  label: string
  icon: IconComponent | null
  current: boolean
}

interface NavigationInput {
  d: Dict
  open: boolean
  sections: SettingsSection[]
  settingsPageExtensions: ExtensionInfo[]
  contentRef: RefObject<HTMLDivElement | null>
}

interface NavState {
  active: SectionId
  anchor: ExtensionAnchor | null
  pageExtId: string | null
  query: string
  searchHits: Record<string, number>
  extensionsExpanded: boolean
  sandboxExpanded: boolean
  extensions: ExtensionInfo[]
  workspaces: Workspace[]
  settingsWorkspaceId: string | null
}

interface SettingsNavModel {
  q: string
  visible: SettingsSection[]
  hitsIn: (id: string) => number
  pageExtensions: ExtensionInfo[]
  shownPage: ExtensionInfo | null
  extensionItems: NavChild[]
  sandboxItems: NavChild[]
  extensionsChildrenShown: boolean
  sandboxChildrenShown: boolean
  inSandbox: boolean
}

export interface SettingsNavigation extends SettingsNavModel {
  active: SectionId
  anchor: ExtensionAnchor | null
  query: string
  hasExtensions: boolean
  searchStore: SearchStore
  changeQuery: (next: string) => void
  onSearchHits: (id: string, hits: number) => void
  expandExtensions: (expanded: boolean) => void
  expandSandbox: (expanded: boolean) => void
  openSection: (id: SectionId) => void
  openExtension: (id: string) => void
  openExtensionPage: (id: string) => void
  openSandboxItem: (id: string) => void
}

interface SettingsRequestsInput {
  open: boolean
  active: SectionId
  sections: SettingsSection[]
  extensions: ExtensionInfo[]
  setActive: (id: SectionId) => void
  setAnchor: Dispatch<SetStateAction<ExtensionAnchor | null>>
  setPageExtId: (id: string | null) => void
  setExtensionsExpanded: (expanded: boolean) => void
  setSandboxExpanded: (expanded: boolean) => void
  changeQuery: (next: string) => void
}

function useSettingsRequests({
  open,
  active,
  sections,
  extensions,
  setActive,
  setAnchor,
  setPageExtId,
  setExtensionsExpanded,
  setSandboxExpanded,
  changeQuery,
}: SettingsRequestsInput): void {
  const requested = useUIStore((s) => s.settingsSection)
  const requestedExtension = useUIStore((s) => s.settingsExtension)
  const requestedRow = useUIStore((s) => s.settingsExtensionRow)
  const requestedQuery = useUIStore((s) => s.settingsQuery)
  const settingsRequest = useUIStore((s) => s.settingsRequest)

  useEffect(() => {
    if (open) countUsage('features', 'settings', active)
  }, [open, active])

  useEffect(() => {
    if (settingsRequest === 0) return
    setActive('workspace')
    setSandboxExpanded(true)
    rememberNavExpanded(SANDBOX_NAV_EXPANDED_KEY, true)
  }, [settingsRequest, setActive, setSandboxExpanded])

  useEffect(() => {
    if (!requested) return
    if (
      requested === 'extensions' &&
      requestedExtension &&
      !requestedRow &&
      extensions.some((e) => e.id === requestedExtension && e.settingsPage)
    ) {
      setActive('extensionPage')
      setPageExtId(requestedExtension)
      setAnchor(null)
    } else if (sections.some((s) => s.id === requested)) {
      setActive(requested as SectionId)
      if (requested === 'extensions' && requestedExtension) {
        setAnchor((prev) => ({ id: requestedExtension, nonce: (prev?.nonce ?? 0) + 1 }))
        setExtensionsExpanded(true)
        rememberNavExpanded(EXTENSIONS_NAV_EXPANDED_KEY, true)
      } else {
        setAnchor(null)
      }
    }
    useUIStore.setState({
      settingsSection: null,
      settingsExtension: null,
      settingsExtensionRow: false,
    })
  }, [
    requested,
    requestedExtension,
    requestedRow,
    sections,
    extensions,
    setActive,
    setPageExtId,
    setAnchor,
    setExtensionsExpanded,
  ])

  useEffect(() => {
    if (requestedQuery === null) return
    changeQuery(requestedQuery)
    useUIStore.setState({ settingsQuery: null })
  }, [requestedQuery, changeQuery])
}

export function useSettingsNavigation({
  d,
  open,
  sections,
  settingsPageExtensions,
  contentRef,
}: NavigationInput): SettingsNavigation {
  const [active, setActive] = useState<SectionId>('appearance')
  const extensions = useExtensionsStore((s) => s.list)
  const [extensionsExpanded, setExtensionsExpanded] = useState(() =>
    navExpanded(EXTENSIONS_NAV_EXPANDED_KEY),
  )
  const [sandboxExpanded, setSandboxExpanded] = useState(() =>
    navExpanded(SANDBOX_NAV_EXPANDED_KEY),
  )
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const [anchor, setAnchor] = useState<ExtensionAnchor | null>(null)
  const [pageExtId, setPageExtId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchStore] = useState(createSearchStore)
  const changeQuery = useCallback(
    (next: string) => {
      setQuery(next)
      searchStore.set(next.trim().toLowerCase())
    },
    [searchStore],
  )
  const [searchHits, setSearchHits] = useState<Record<string, number>>({})
  const onSearchHits = useCallback(
    (id: string, hits: number) =>
      setSearchHits((prev) => (prev[id] === hits ? prev : { ...prev, [id]: hits })),
    [],
  )
  const settingsWorkspaceId = useUIStore((s) => s.settingsWorkspaceId)

  useSettingsRequests({
    open,
    active,
    sections,
    extensions,
    setActive,
    setAnchor,
    setPageExtId,
    setExtensionsExpanded,
    setSandboxExpanded,
    changeQuery,
  })

  const expandExtensions = (expanded: boolean): void => {
    setExtensionsExpanded(expanded)
    rememberNavExpanded(EXTENSIONS_NAV_EXPANDED_KEY, expanded)
  }

  const expandSandbox = (expanded: boolean): void => {
    setSandboxExpanded(expanded)
    rememberNavExpanded(SANDBOX_NAV_EXPANDED_KEY, expanded)
  }

  const openSandboxItem = (id: string): void => {
    if (id === SANDBOX_DEFAULTS_ITEM) {
      openSection('sandbox')
      return
    }
    changeQuery('')
    useUIStore.setState({ settingsWorkspaceId: id })
    openSection('workspace')
  }

  const revealResult = (id: string): void => {
    contentRef.current
      ?.querySelector(`[data-settings-result="${id}"]`)
      ?.scrollIntoView({ block: 'start' })
  }

  const openSection = (id: SectionId): void => {
    setActive(id)
    setAnchor(null)
    revealResult(id)
  }

  const openExtension = (id: string): void => {
    setActive('extensions')
    setAnchor((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const openExtensionPage = (id: string): void => {
    setActive('extensionPage')
    setPageExtId(id)
    setAnchor(null)
    revealResult(extensionPageResultId(id))
  }

  const state: NavState = {
    active,
    anchor,
    pageExtId,
    query,
    searchHits,
    extensionsExpanded,
    sandboxExpanded,
    extensions,
    workspaces,
    settingsWorkspaceId,
  }
  return {
    ...navModel(d, sections, settingsPageExtensions, state),
    active,
    anchor,
    query,
    hasExtensions: extensions.length > 0,
    searchStore,
    changeQuery,
    onSearchHits,
    expandExtensions,
    expandSandbox,
    openSection,
    openExtension,
    openExtensionPage,
    openSandboxItem,
  }
}

function navModel(
  d: Dict,
  sections: SettingsSection[],
  settingsPageExtensions: ExtensionInfo[],
  {
    active,
    anchor,
    pageExtId,
    query,
    searchHits,
    extensionsExpanded,
    sandboxExpanded,
    extensions,
    workspaces,
    settingsWorkspaceId,
  }: NavState,
): SettingsNavModel {
  const q = query.trim().toLowerCase()
  const matchingExtensions = q ? extensions.filter((e) => extensionMatchesQuery(e, q)) : extensions
  const hitsIn = (id: string): number => (q ? (searchHits[id] ?? 0) : 0)
  const pageExtensions = q
    ? settingsPageExtensions.filter(
        (e) => extensionMatchesQuery(e, q) || hitsIn(extensionPageResultId(e.id)) > 0,
      )
    : settingsPageExtensions
  const shownPage =
    active === 'extensionPage' ? extensions.find((e) => e.id === pageExtId && e.settingsPage) : null
  const sandboxWorkspaces = workspaces
    .filter((w) => w.kind !== 'manager')
    .map((w) => ({ id: w.id, name: workspaceTitle(w) }))
  const matchingWorkspaces = q
    ? sandboxWorkspaces.filter((w) => w.name.toLowerCase().includes(q))
    : sandboxWorkspaces
  const visible = q
    ? sections.filter(
        (s) =>
          matchesQuery([s.label], q) ||
          hitsIn(s.id) > 0 ||
          (s.id === 'extensions' && (matchingExtensions.length > 0 || pageExtensions.length > 0)) ||
          (s.id === 'sandbox' && matchingWorkspaces.length > 0),
      )
    : sections
  const navExtensions = q ? matchingExtensions : extensions
  const extensionsChildrenShown = navExtensions.length > 0 && (q !== '' || extensionsExpanded)
  const extensionItems: NavChild[] = navExtensions.map((ext) => ({
    id: ext.id,
    label: ext.name,
    icon: ext.panel?.icon ? extensionIcon(ext.panel.icon) : null,
    current: active === 'extensions' && anchor?.id === ext.id,
  }))
  const sandboxItems: NavChild[] = [
    ...(q
      ? []
      : [
          {
            id: SANDBOX_DEFAULTS_ITEM,
            label: d.sandbox.defaults,
            icon: null,
            current: active === 'sandbox',
          },
        ]),
    ...matchingWorkspaces.map((w) => ({
      id: w.id,
      label: w.name,
      icon: null,
      current: active === 'workspace' && settingsWorkspaceId === w.id,
    })),
  ]
  const sandboxChildrenShown = q ? matchingWorkspaces.length > 0 : sandboxExpanded
  const inSandbox = active === 'sandbox' || active === 'workspace'
  return {
    q,
    visible,
    hitsIn,
    pageExtensions,
    shownPage: shownPage ?? null,
    extensionItems,
    sandboxItems,
    extensionsChildrenShown,
    sandboxChildrenShown,
    inSandbox,
  }
}
