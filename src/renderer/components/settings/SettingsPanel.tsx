import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import { AgentsSection } from '@/components/agents/AgentsSection'
import { ClaudeAccountsSection } from '@/components/agents/ClaudeAccountsSection'
import { PlaybooksSection } from '@/components/agents/PlaybooksSection'
import { AboutSection } from '@/components/app/AboutSection'
import { AssistantSection } from '@/components/assist/AssistantSection'
import { BrowseExtensionsDialog } from '@/components/extensions/BrowseExtensions'
import {
  ExtensionSettingsPage,
  ExtensionsPage,
} from '@/components/extensions/ExtensionSettingsPage'
import type { ExtensionAnchor } from '@/components/extensions/InstalledExtensions'
import { GatewaySection } from '@/components/gateway/GatewaySection'
import { KeyboardSection } from '@/components/keyboard/KeyboardSection'
import { PanesSection } from '@/components/panes/PanesSection'
import { SandboxSection } from '@/components/sandbox/SandboxSection'
import { WorkspaceSandboxPage } from '@/components/sandbox/WorkspaceSandboxPage'
import { ScriptTokensSection } from '@/components/scriptTokens/ScriptTokensSection'
import { type SearchStore, SettingsSearchSection } from '@/components/settingsKit/SettingsSearch'
import { SharesSection } from '@/components/shares/SharesSection'
import { SidebarSection } from '@/components/sidebar/SidebarSection'
import { TerminalSection } from '@/components/terminal/TerminalSection'
import { DialogContainer } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ViewsSection } from '@/components/views/ViewsSection'
import { useDict } from '@/lib/app/useDict'
import { openFileInWorkspace } from '@/lib/files/openFile'
import {
  extensionPageResultId,
  pageTitle,
  type SectionId,
  settingsSections,
} from '@/lib/settings/settingsSections'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { ActionsSection } from './ActionsSection'
import { AppearanceSection } from './AppearanceSection'
import { GitSection, PortsSection } from './BoardSettings'
import { BrowserSettingsSection, EditorSettingsSection } from './BrowserEditorSettings'
import { FilesSection } from './FilesSettingsSection'
import { ManagerSection } from './ManagerSection'
import { NotificationsSection } from './NotificationsSection'
import { PasswordsSection } from './PasswordsSection'
import { PrivacySection } from './PrivacySection'
import { PromptSection } from './PromptSection'
import { SettingsNav } from './SettingsNav'
import { SyncSection } from './SyncSection'
import { useSettingsNavigation } from './useSettingsNavigation'
import { WorkspacesSection } from './WorkspacesSection'

export function SettingsPanel(): JSX.Element | null {
  const d = useDict()
  const open = useUIStore((s) => s.settingsActive)
  const close = useUIStore((s) => s.showWorkspaces)
  const browsing = useUIStore((s) => s.browseExtensionsOpen)
  const closeBrowse = useUIStore((s) => s.closeBrowseExtensions)
  const extensions = useExtensionsStore((s) => s.list)
  const contentRef = useRef<HTMLDivElement>(null)
  const settingsWorkspaceId = useUIStore((s) => s.settingsWorkspaceId)
  const targetWorkspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === settingsWorkspaceId),
  )
  const navRef = useRef<HTMLElement>(null)
  const sections = useMemo(() => settingsSections(d), [d])
  const settingsPageExtensions = useMemo(
    () => extensions.filter((e) => e.settingsPage),
    [extensions],
  )
  const nav = useSettingsNavigation({ d, open, sections, settingsPageExtensions, contentRef })
  const [dialogHost, setDialogHost] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) closeBrowse()
  }, [open, closeBrowse])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    navRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => prev?.focus?.()
  }, [open])

  const openSettingsFile = async (): Promise<void> => {
    const path = await window.ostia.settings.path()
    close()
    openFileInWorkspace(path)
  }

  if (!open) return null

  return (
    <section
      aria-label={d.settings.title}
      className="motion-fade absolute inset-0 z-20 flex min-h-0 flex-col bg-bg text-fg"
    >
      <div className="grid min-h-0 flex-1 grid-cols-[210px_minmax(0,1fr)]">
        <SettingsNav
          navRef={navRef}
          contentRef={contentRef}
          nav={nav}
          openSettingsFile={openSettingsFile}
        />

        <div className="relative flex min-h-0 flex-col [contain:layout]">
          <DialogContainer.Provider value={dialogHost}>
            <ScrollArea className="min-h-0 flex-1">
              <div
                ref={contentRef}
                data-slot="settings-content"
                className="mx-auto max-w-3xl select-text px-8 py-5 [&_[data-slot=kbd]]:pointer-events-auto [&_[data-slot=kbd]]:select-text [&_[data-slot=label]]:select-text"
              >
                {nav.q && nav.visible.length === 0 ? (
                  <p className="text-fg-muted text-ui-sm">{d.settings.noMatches}</p>
                ) : null}
                <SettingsPages
                  searching={nav.q !== ''}
                  active={nav.active}
                  sections={sections}
                  settingsPageExtensions={settingsPageExtensions}
                  shownPage={nav.shownPage}
                  anchor={nav.anchor}
                  targetWorkspace={targetWorkspace}
                  store={nav.searchStore}
                  onHits={nav.onSearchHits}
                />
              </div>
            </ScrollArea>
          </DialogContainer.Provider>
          <div ref={setDialogHost} />
        </div>
      </div>
      {browsing ? <BrowseExtensionsDialog /> : null}
    </section>
  )
}

const SettingsPages = memo(function SettingsPages({
  searching,
  active,
  sections,
  settingsPageExtensions,
  shownPage,
  anchor,
  targetWorkspace,
  store,
  onHits,
}: {
  searching: boolean
  active: SectionId
  sections: { id: SectionId; label: string }[]
  settingsPageExtensions: ExtensionInfo[]
  shownPage: ExtensionInfo | null
  anchor: ExtensionAnchor | null
  targetWorkspace: Workspace | undefined
  store: SearchStore
  onHits: (id: string, hits: number) => void
}): JSX.Element {
  const page = (id: SectionId): React.ReactNode => (
    <>
      {id === 'appearance' ? <AppearanceSection /> : null}
      {id === 'terminal' ? <TerminalSection /> : null}
      {id === 'prompt' ? <PromptSection /> : null}
      {id === 'keyboard' ? (
        <>
          <KeyboardSection />
          <ActionsSection />
        </>
      ) : null}
      {id === 'panes' ? <PanesSection /> : null}
      {id === 'notifications' ? <NotificationsSection /> : null}
      {id === 'sidebar' ? <SidebarSection /> : null}
      {id === 'workspaces' ? <WorkspacesSection /> : null}
      {id === 'sandbox' ? <SandboxSection /> : null}
      {id === 'workspace' && targetWorkspace ? (
        <WorkspaceSandboxPage
          key={targetWorkspace.id}
          workspaceId={targetWorkspace.id}
          workspaceName={workspaceTitle(targetWorkspace)}
        />
      ) : null}
      {id === 'claudeAccounts' ? <ClaudeAccountsSection /> : null}
      {id === 'agents' ? <AgentsSection /> : null}
      {id === 'playbooks' ? <PlaybooksSection /> : null}
      {id === 'assistant' ? <AssistantSection /> : null}
      {id === 'manager' ? <ManagerSection /> : null}
      {id === 'files' ? <FilesSection /> : null}
      {id === 'git' ? <GitSection /> : null}
      {id === 'ports' ? <PortsSection /> : null}
      {id === 'browser' ? <BrowserSettingsSection /> : null}
      {id === 'passwords' ? <PasswordsSection /> : null}
      {id === 'scriptTokens' ? <ScriptTokensSection /> : null}
      {id === 'privacy' ? <PrivacySection /> : null}
      {id === 'editor' ? <EditorSettingsSection /> : null}
      {id === 'extensions' || (id === 'extensionPage' && !shownPage) ? (
        <ExtensionsPage anchor={anchor} />
      ) : null}
      {id === 'extensionPage' && shownPage ? (
        <ExtensionSettingsPage key={shownPage.id} ext={shownPage} />
      ) : null}
      {id === 'views' ? <ViewsSection /> : null}
      {id === 'remote' ? <GatewaySection /> : null}
      {id === 'sync' ? <SyncSection /> : null}
      {id === 'shares' ? <SharesSection /> : null}
      {id === 'about' ? <AboutSection /> : null}
    </>
  )
  if (!searching) return <>{page(active)}</>
  return (
    <>
      {sections.map((s) => (
        <Fragment key={s.id}>
          <SettingsSearchSection id={s.id} label={s.label} store={store} onHits={onHits}>
            {page(s.id)}
          </SettingsSearchSection>
          {s.id === 'extensions'
            ? settingsPageExtensions.map((ext) => (
                <SettingsSearchSection
                  key={ext.id}
                  id={extensionPageResultId(ext.id)}
                  label={pageTitle(ext)}
                  store={store}
                  onHits={onHits}
                >
                  <ExtensionSettingsPage ext={ext} />
                </SettingsSearchSection>
              ))
            : null}
        </Fragment>
      ))}
    </>
  )
})
