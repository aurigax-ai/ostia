import type { SandboxViolation } from '@shared/sandbox/sandbox'
import { type JSX, useCallback, useEffect, useState } from 'react'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDate, TIME_ONLY } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'

const REFRESH_MS = 3000

export function SandboxViolations({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [list, setList] = useState<SandboxViolation[]>([])
  const load = useCallback(
    () => void window.ostia.sandbox.violations(workspaceId).then(setList),
    [workspaceId],
  )
  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])
  return (
    <SettingsGroup
      title={d.sandbox.violations}
      desc={isMac ? d.sandbox.violationsMac : d.sandbox.violationsLinux}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={list.length === 0}
          onClick={() => void window.ostia.sandbox.clearViolations(workspaceId).then(load)}
        >
          {d.sandbox.violationsClear}
        </Button>
      }
    >
      <SettingsList label={d.sandbox.violations} empty={d.sandbox.violationsEmpty}>
        {list.map((v) => {
          const reason = d.sandbox.violationReasons[v.reason] || v.detail
          return (
            <SettingsListRow
              key={v.id}
              lead={
                <Badge variant="outline" className="min-w-16 justify-center text-ui-xs">
                  {d.sandbox.violationKinds[v.kind]}
                </Badge>
              }
              title={<span className="font-mono">{v.target}</span>}
              detail={
                <span className="tabular-nums">
                  {reason} ·{' '}
                  {fmt(d.sandbox.violationCount, {
                    count: v.count,
                    time: formatDate(v.last, locale, TIME_ONLY),
                  })}
                </span>
              }
              actions={
                v.allowHost ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      void window.ostia.sandbox
                        .allowRefused(workspaceId, v.allowHost as string)
                        .then(load)
                    }
                  >
                    {d.sandbox.allow}
                  </Button>
                ) : null
              }
            />
          )
        })}
      </SettingsList>
    </SettingsGroup>
  )
}
