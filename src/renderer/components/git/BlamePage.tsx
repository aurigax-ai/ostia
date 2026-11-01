import { type GitBlameData, isUncommitted } from '@shared/boards/git'
import type { JSX } from 'react'
import { useDict } from '@/lib/app/useDict'
import { absoluteTime, relativeTime, shortSha } from '@/lib/git/gitView'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function BlamePage({ data }: { data: GitBlameData }): JSX.Element {
  const t = useDict().git
  const locale = useSettingsStore((s) => s.locale)
  const now = Date.now()
  return (
    <div className="blame-scroll">
      <table className="blame">
        <tbody>
          {data.lines.map((line, i) => {
            const first = i === 0 || data.lines[i - 1].sha !== line.sha
            const pending = isUncommitted(line.sha)
            const label = pending
              ? t.uncommitted
              : `${shortSha(line.sha)} ${line.author} · ${relativeTime(line.time, now, locale)}`
            return (
              <tr
                key={line.line}
                className={first ? 'blame-first' : undefined}
                data-line={line.line}
                data-sha={line.sha}
              >
                <td
                  className="blame-who muted"
                  title={
                    pending ? t.uncommitted : `${line.summary}\n${absoluteTime(line.time, locale)}`
                  }
                >
                  {first ? label : ''}
                </td>
                <td className="blame-no muted">{line.line}</td>
                <td className="blame-text">{line.text}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
