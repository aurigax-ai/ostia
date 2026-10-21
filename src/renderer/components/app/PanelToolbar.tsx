import { IconButton } from '@/components/common/IconButton'
import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { Tabs } from '@/components/ui/tabs'
import { fmt, useDict } from '@/lib/app/useDict'
import { sendPanelToolbarEvent } from '@/lib/extensions/panelWebviews'
import { hideRightPanel } from '@/lib/panes/rightPanelFocus'
import { toolbarStateOf, usePanelToolbarStore } from '@/stores/extensions/panelToolbarStore'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { ArrowLeftIcon, XIcon } from '@phosphor-icons/react'

export function PanelToolbar({
  ext,
  workspaceId,
  focusKey,
}: {
  ext: ExtensionInfo
  workspaceId: string
  focusKey: string
}): JSX.Element {
  const d = useDict()
  const entries = usePanelToolbarStore((s) => s.entries)
  const state = toolbarStateOf(entries, ext.id, workspaceId)
  const title = ext.panel?.title ?? ext.name
  const tabs = ext.panel?.toolbar?.tabs ?? []
  const actions = ext.panel?.toolbar?.actions ?? []
  const hidden = new Set(state.hidden)
  const disabled = new Set(state.disabled)
  const tab = state.tab ?? tabs[0]?.id ?? ''
  return (
    <div className="panel-toolbar">
      {state.back ? (
        <div className="panel-toolbar-lead">
          <IconButton
            icon={ArrowLeftIcon}
            label={d.extensions.panelBack}
            onClick={() => sendPanelToolbarEvent(focusKey, { kind: 'back' })}
          />
          <span className="panel-toolbar-title">{state.back}</span>
        </div>
      ) : tabs.length > 0 ? (
        <Tabs
          value={tab}
          onValueChange={(next) => {
            usePanelToolbarStore.getState().selectTab(ext.id, workspaceId, String(next))
            sendPanelToolbarEvent(focusKey, { kind: 'tab', id: String(next) })
          }}
          className="h-full min-w-0 flex-1 gap-0 data-horizontal:flex-row"
        >
          <SectionTabsList className="h-full w-auto border-b-0">
            {tabs
              .filter((t) => !hidden.has(t.id))
              .map((t) => (
                <SectionTab key={t.id} value={t.id} disabled={disabled.has(t.id)}>
                  {t.title}
                  {state.badges?.[t.id] ? (
                    <span className="panel-toolbar-badge">{state.badges[t.id]}</span>
                  ) : null}
                </SectionTab>
              ))}
          </SectionTabsList>
        </Tabs>
      ) : (
        <div className="panel-toolbar-lead">
          <span className="panel-toolbar-title">{title}</span>
        </div>
      )}
      <div className="panel-toolbar-actions">
        {state.back
          ? null
          : actions
              .filter((a) => !hidden.has(a.id))
              .map((a) => (
                <IconButton
                  key={a.id}
                  icon={extensionIcon(a.icon)}
                  label={a.title}
                  disabled={disabled.has(a.id)}
                  onClick={() => sendPanelToolbarEvent(focusKey, { kind: 'action', id: a.id })}
                />
              ))}
        <IconButton
          icon={XIcon}
          label={fmt(d.extensions.closePanel, { name: title })}
          data-panel-close=""
          onClick={hideRightPanel}
        />
      </div>
    </div>
  )
}
