import { FileCode, GitPullRequest, X } from 'lucide-react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { UsageMeter } from './UsageMeter'

/**
 * Right column (ref merge: three-column workspace). Contextual to the active channel —
 * a code-review surface + agent telemetry. Phase 0 is an evocative placeholder; real
 * diffs arrive with Git UI (Phase 7), agent steps with the Agent manager (Phase 14).
 */
export function Inspector(): JSX.Element {
  const d = useDict()
  const open = useUIStore((s) => s.inspectorOpen)
  const active = useSessionsStore((s) => s.sessions.find((c) => c.id === s.activeSessionId))

  return (
    <aside className={`inspector${open ? '' : ' collapsed'}`}>
      <div className="inspector-head drag-region">
        <GitPullRequest size={14} />
        <span className="inspector-title">{d.inspector.review}</span>
        <span className="inspector-branch">{active?.workDir ?? '—'}</span>
        <button
          type="button"
          className="iconbtn"
          title="Close inspector (⌘J)"
          onClick={() => commands.exec('view.toggleInspector')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="inspector-body">
        <div className="insp-section">{d.inspector.uncommitted}</div>
        <DiffRow file="src/slack_reader.py" add={270} del={0} />
        <DiffRow file="src/commands/history.ts" add={48} del={12} />
        <DiffRow file="README.md" add={6} del={2} />

        <div className="insp-section">{d.inspector.agent}</div>
        <div className="agent-note">
          Reworked <b>get_channel_history</b> to default hours to 24 and cap messages at 100.
        </div>
        <div className="agent-meters">
          <UsageMeter label="context" filled={5} total={10} value="58k / 1M" tone="accent" />
          <UsageMeter label="weekly" filled={9} total={10} value="90%" tone="attn" />
        </div>
        <div className="agent-hint">{d.inspector.acceptHint}</div>
      </div>
    </aside>
  )
}

function DiffRow({ file, add, del }: { file: string; add: number; del: number }): JSX.Element {
  return (
    <div className="diff-row" title={file}>
      <FileCode size={13} className="diff-icon" />
      <span className="diff-file">{file}</span>
      <span className="diff-add">+{add}</span>
      <span className="diff-del">-{del}</span>
    </div>
  )
}
