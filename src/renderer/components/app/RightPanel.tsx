import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { PanelInbox } from '@/components/agents/PanelInbox'
import { PanelToolbar } from '@/components/app/PanelToolbar'
import { EmptyState } from '@/components/common/EmptyState'
import { PanelResizer } from '@/components/common/PanelResizer'
import { ExtensionSidePanel } from '@/components/extensions/ExtensionSidePanel'
import { GitView } from '@/components/git/GitView'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { GIT_PANEL_ID } from '@/lib/git/gitPanel'
import { instanceKey, type PanelInstance, sameInstance } from '@/lib/panes/panelKeepAlive'
import { rightPanelWidth } from '@/lib/panes/panelWidth'
import { hideRightPanel, RIGHT_PANEL_ID, rightFocusKey } from '@/lib/panes/rightPanelFocus'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type PanelRoute, useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import {
  surfaceKey,
  toolbarStateOf,
  usePanelToolbarStore,
} from '@/stores/extensions/panelToolbarStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

function hasPanel(ext: ExtensionInfo): boolean {
  return ext.enabled && ext.panel !== null
}

function useInert<T extends HTMLElement>(inert: boolean): React.RefObject<T> {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = inert
  }, [inert])
  return ref
}

function PanelSlot({
  shown,
  children,
}: {
  shown: boolean
  children: React.ReactNode
}): JSX.Element {
  const ref = useInert<HTMLDivElement>(!shown)
  return (
    <div ref={ref} className="right-panel-slot" data-hidden={shown ? undefined : ''}>
      {children}
    </div>
  )
}

function inboxTabOf(
  ext: ExtensionInfo,
  shownTab: string | undefined,
  chosen: boolean,
): string | undefined {
  if (!ext.builtin) return undefined
  const tabs = ext.panel?.toolbar?.tabs ?? []
  const inbox = tabs.find((tab) => tab.surface === 'inbox')
  if (!inbox) return undefined
  const current = chosen
    ? inbox.id
    : (shownTab ?? tabs.find((tab) => tab.id !== inbox.id)?.id ?? tabs[0]?.id)
  return inbox.id === current ? inbox.id : undefined
}

function ExtensionBody({
  ext,
  workspaceId,
  focusKey,
  route,
  hidden,
}: {
  ext: ExtensionInfo
  workspaceId: string
  focusKey: string
  route: PanelRoute | undefined
  hidden: boolean
}): JSX.Element {
  const entries = usePanelToolbarStore((s) => s.entries)
  const chosen = usePanelToolbarStore(
    (s) => s.surfaceChosen[surfaceKey(ext.id, workspaceId)] === true,
  )
  const inbox = inboxTabOf(ext, toolbarStateOf(entries, ext.id, workspaceId).tab, chosen)
  const webRef = useInert<HTMLDivElement>(inbox !== undefined)
  return (
    <div className="right-panel-content">
      <div ref={webRef} className="right-panel-web" data-hidden={inbox ? '' : undefined}>
        <ExtensionSidePanel
          extId={ext.id}
          workspaceId={workspaceId}
          focusKey={focusKey}
          route={route}
          hidden={hidden || inbox !== undefined}
        />
      </div>
      {inbox ? (
        <div className="right-panel-inbox">
          <PanelInbox extId={ext.id} workspaceId={workspaceId} />
        </div>
      ) : null}
    </div>
  )
}

function SandboxedLine({ ext, instance }: { ext: ExtensionInfo; instance: PanelInstance }) {
  const d = useDict()
  const reveal = useSidePanelStore((s) => s.reveal)
  return (
    <div className="px-2">
      <EmptyState
        variant="block"
        title={d.extensions.sandboxedClosed}
        action={
          <Button size="sm" variant="outline" onClick={() => reveal(instance)}>
            {fmt(d.extensions.showPanel, { name: ext.panel?.title ?? ext.name })}
          </Button>
        }
      />
    </div>
  )
}

export function RightPanel(): JSX.Element {
  const d = useDict()
  const right = useSidePanelStore((s) => s.right)
  const kept = useSidePanelStore((s) => s.kept)
  const routes = useSidePanelStore((s) => s.routes)
  const revealed = useSidePanelStore((s) => s.revealed)
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const list = useExtensionsStore((s) => s.list)
  const sandboxed = useSandboxStore((s) =>
    workspaceId ? (s.enabled[workspaceId] ?? false) : false,
  )
  const gitOn = useSettingsStore((s) => s.git.enabled)
  const panels = new Map<string, string>(
    list.filter(hasPanel).map((ext) => [ext.id, ext.panel?.title ?? ext.name]),
  )
  if (gitOn) panels.set(GIT_PANEL_ID, d.git.title)
  const shownTitle = right ? panels.get(right) : undefined
  const shownExt = right && right !== GIT_PANEL_ID ? list.find((e) => e.id === right) : undefined
  const instance: PanelInstance | null =
    right && shownTitle && workspaceId ? { extId: right, workspaceId } : null
  const gated =
    instance !== null &&
    instance.extId !== GIT_PANEL_ID &&
    sandboxed &&
    !revealed.includes(instanceKey(instance))
  const open = instance !== null
  const asideRef = useInert<HTMLElement>(!open)

  const shownExtId = instance?.extId ?? null
  useEffect(() => {
    if (shownExtId && workspaceId && !gated) {
      useSidePanelStore.getState().keep({ extId: shownExtId, workspaceId })
    }
  }, [shownExtId, workspaceId, gated])

  const liveWorkspaces = useWorkspacesStore((s) => s.workspaces.map((w) => w.id).join('\n'))
  useEffect(() => {
    useSidePanelStore.getState().forgetWorkspaces(new Set(liveWorkspaces.split('\n')))
  }, [liveWorkspaces])

  useEffect(
    () =>
      useSandboxStore.subscribe((s, prev) => {
        for (const [id, on] of Object.entries(s.enabled)) {
          if (on && !prev.enabled[id]) useSidePanelStore.getState().unload(id)
        }
      }),
    [],
  )

  useEffect(() => {
    if (list.length === 0) return
    const known = new Set(list.filter(hasPanel).map((ext) => ext.id))
    if (gitOn) known.add(GIT_PANEL_ID)
    const { kept: live, right: shown, drop } = useSidePanelStore.getState()
    const gone = new Set([...live.map((i) => i.extId), ...(shown ? [shown] : [])])
    for (const extId of gone) if (!known.has(extId)) drop(extId)
  }, [list, gitOn])

  return (
    <aside
      ref={asideRef}
      id={RIGHT_PANEL_ID}
      className="right-panel"
      aria-label={shownTitle}
      data-hidden={open ? undefined : ''}
    >
      <div className="right-panel-body">
        {[...kept]
          .filter((i) => panels.has(i.extId))
          .sort((a, b) => instanceKey(a).localeCompare(instanceKey(b)))
          .map((i) => (
            <PanelSlot key={instanceKey(i)} shown={instance !== null && sameInstance(i, instance)}>
              {i.extId === GIT_PANEL_ID ? (
                <GitView
                  workspaceId={i.workspaceId}
                  paneId={rightFocusKey(i.extId, i.workspaceId)}
                  home="dock"
                  active={instance !== null && sameInstance(i, instance)}
                  onClose={hideRightPanel}
                />
              ) : (
                <>
                  <PanelToolbar
                    ext={list.find((e) => e.id === i.extId) as ExtensionInfo}
                    workspaceId={i.workspaceId}
                    focusKey={rightFocusKey(i.extId, i.workspaceId)}
                  />
                  <ExtensionBody
                    ext={list.find((e) => e.id === i.extId) as ExtensionInfo}
                    workspaceId={i.workspaceId}
                    focusKey={rightFocusKey(i.extId, i.workspaceId)}
                    route={routes[instanceKey(i)]}
                    hidden={instance === null || !sameInstance(i, instance)}
                  />
                </>
              )}
            </PanelSlot>
          ))}
        {gated && instance && shownExt ? (
          <div className="right-panel-sandboxed">
            <PanelToolbar
              bare
              ext={shownExt}
              workspaceId={instance.workspaceId}
              focusKey={rightFocusKey(instance.extId, instance.workspaceId)}
            />
            <SandboxedLine ext={shownExt} instance={instance} />
          </div>
        ) : null}
      </div>
      {open && right ? (
        <PanelResizer
          key={right}
          spec={rightPanelWidth(right)}
          side="right"
          label={fmt(d.extensions.resizePanel, { name: shownTitle ?? right })}
          controls={RIGHT_PANEL_ID}
          className="right-resizer"
        />
      ) : null}
    </aside>
  )
}
