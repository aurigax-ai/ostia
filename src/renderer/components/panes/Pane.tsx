import { commands } from '@/commands/registry'
import { ApprovalCard } from '@/components/agents/ApprovalCard'
import { QuestionNotice } from '@/components/agents/QuestionNotice'
import { PaneChips } from '@/components/extensions/ExtensionChips'
import { ArtifactChip } from '@/components/files/ArtifactChip'
import { HostPaneBadge, SandboxRestartButton } from '@/components/sandbox/SandboxRestartButton'
import { useDict } from '@/lib/app/useDict'
import { allPanes, findPane } from '@/lib/layout/tree'
import type { TabNode } from '@/lib/layout/types'
import { cn } from '@/lib/utils'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'
import { FoldedSplitTab } from './FoldedSplitTab'
import { PaneActions } from './PaneActions'
import { PaneTab } from './PaneTab'
import { ResumeConflictNotice, ResumeFailedNotice, ResumeFolderNotice } from './ResumeFolderNotice'
import { SplitTabPill } from './SplitTab'
import { SplitTabBody } from './SplitTabBody'
import { TabBody } from './TabBody'
import { TabRow } from './TabRow'
import { paneDropHandlers } from './paneDropHandlers'
import { usePaneFrame } from './usePaneFrame'

interface PaneProps {
  tabs: TabNode[]
  shownId: string
  activePaneId: string
  workspaceId: string
  split?: boolean
}

function holds(tab: TabNode, paneId: string): boolean {
  return tab.type === 'pane' ? tab.id === paneId : findPane(tab, paneId) !== null
}

export function Pane({
  tabs,
  shownId,
  activePaneId,
  workspaceId,
  split = false,
}: PaneProps): JSX.Element {
  const d = useDict()
  const shownTab = tabs.find((t) => holds(t, shownId)) ?? tabs[0]
  const shown =
    shownTab.type === 'pane' ? shownTab : (findPane(shownTab, shownId) ?? allPanes(shownTab)[0])
  const active = holds(shownTab, activePaneId)
  const dragging = usePaneDnd((s) => s.dragging)
  const over = usePaneDnd((s) => (s.overId === shown.id ? s.zone : null))
  const tabDrop = usePaneDnd((s) => (s.overId === shown.id ? s.tab : null))
  const attention = useAttentionStore((s) => s.byPane[shown.id])
  const approval = useApprovalsStore((s) => s.pending.find((r) => r.paneId === shown.id))
  const question = useQuestionsStore((s) => s.pending.find((q) => q.paneId === shown.id))
  const unread = attention?.unread ?? false
  const dimInactive = useSettingsStore((s) => s.panes.dimInactive)
  const hideTabClose = useSettingsStore((s) => s.panes.hideTabClose)
  const frameRef = usePaneFrame({ shown, activePaneId })

  const { tabIds, onLayerDragOver, onLayerDrop, onHeaderDragOver, onHeaderDrop } = paneDropHandlers(
    {
      tabs,
      shown,
      frameRef,
    },
  )

  return (
    <div
      className={`pane${active ? ' active' : ''}${split && !active && dimInactive ? ' dimmed' : ''}`}
      data-attention={unread ? attention?.state : undefined}
      data-pane-id={shown.id}
      ref={frameRef}
    >
      <div
        className={cn('pane-header', over === 'center' && 'drop-tab')}
        onDragOver={onHeaderDragOver}
        onDragLeave={() => usePaneDnd.getState().leave(shown.id)}
        onDrop={onHeaderDrop}
      >
        <TabRow
          tabs={tabs}
          shownTabId={shownTab.id}
          label={d.pane.tabs}
          onNewTab={() => void commands.exec('tab.new', { paneId: shown.id })}
        >
          {tabs.map((tab) => {
            const dropMark =
              tabDrop?.targetId === tab.id ? (tabDrop.after ? 'after' : 'before') : null
            return tab.type === 'pane' ? (
              <PaneTab
                key={tab.id}
                pane={tab}
                selected={tab === shownTab}
                dropMark={dropMark}
                showClose={!hideTabClose}
              />
            ) : tab.folded ? (
              <FoldedSplitTab
                key={tab.id}
                tab={tab}
                dropMark={dropMark}
                workspaceId={workspaceId}
              />
            ) : (
              <SplitTabPill
                key={tab.id}
                tab={tab}
                selected={tab === shownTab}
                focusedId={shown.id}
                dropMark={dropMark}
                showClose={!hideTabClose}
                workspaceId={workspaceId}
              />
            )
          })}
        </TabRow>
        {unread && attention?.message ? (
          <span className="pane-attn">
            <span className="pane-attn-msg">{attention.message}</span>
          </span>
        ) : null}
        <ArtifactChip workspaceId={workspaceId} paneId={shown.id} />
        <PaneChips paneId={shown.id} />
        <SandboxRestartButton pane={shown} />
        <HostPaneBadge pane={shown} />
        <PaneActions pane={shown} workspaceId={workspaceId} />
      </div>

      <div className="pane-body pane-body-term">
        {tabs.map((tab) =>
          tab.type === 'pane' ? (
            <TabBody key={tab.id} pane={tab} shown={tab === shownTab} />
          ) : (
            <SplitTabBody
              key={tab.id}
              tab={tab}
              workspaceId={workspaceId}
              shown={tab === shownTab}
              focusedId={shown.id}
              frameActive={active}
              stackTabIds={tabIds}
            />
          ),
        )}
        {shownTab.type !== 'pane' ? null : approval ? (
          <ApprovalCard request={approval} paneTitle={shown.title} />
        ) : question ? (
          <QuestionNotice question={question} />
        ) : shown.resumeFailed ? (
          <ResumeFailedNotice paneId={shown.id} failure={shown.resumeFailed} />
        ) : shown.resumeFolderMissing && shown.resume ? (
          <ResumeFolderNotice
            paneId={shown.id}
            resume={shown.resume}
            folder={shown.resumeFolderMissing}
          />
        ) : shown.resume ? (
          <ResumeConflictNotice pane={shown} />
        ) : null}
      </div>

      {shown.kind === 'terminal' ? null : <div className="pane-file-drop" />}
      {dragging && shownTab.type === 'pane' ? (
        <div
          className="pane-drop-layer"
          onDragOver={onLayerDragOver}
          onDragLeave={() => usePaneDnd.getState().leave(shown.id)}
          onDrop={onLayerDrop}
        />
      ) : null}
      {over && !tabDrop ? <span className={`pane-drop pane-drop-${over}`} /> : null}
    </div>
  )
}
