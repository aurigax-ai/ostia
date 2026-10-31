import { Hint } from '@/components/common/Hint'
import { fmt, useDict } from '@/lib/app/useDict'
import { type RowMark, stateCounts } from '@/lib/workspaces/rowSummary'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'

export function GroupStateChips({ members }: { members: Workspace[] }): JSX.Element | null {
  const d = useDict()
  const counts = stateCounts(members.map((w) => w.state))
  const chips: [RowMark, string][] = [
    ['waiting', d.rail.groupWaiting],
    ['error', d.rail.groupError],
    ['working', d.rail.groupWorking],
  ]
  const shown = chips.filter(([mark]) => counts[mark] > 0)
  if (shown.length === 0) return null
  return (
    <span className="rail-group-chips">
      {shown.map(([mark, text]) => {
        const label = fmt(text, { n: counts[mark] })
        return (
          <Hint key={mark} label={label}>
            <span className="rail-group-chip" role="img" aria-label={label}>
              <span className={`state-dot ${mark}`} aria-hidden />
              {counts[mark]}
            </span>
          </Hint>
        )
      })}
    </span>
  )
}
