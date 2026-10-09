import { SettingsGroup } from '@/components/settings/SettingsPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/i18n/useDict'
import { isMac } from '@/platform'
import type { SandboxViolation } from '@shared/sandbox'
import { useCallback, useEffect, useState } from 'react'

const REFRESH_MS = 3000

export function SandboxViolations({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
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
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' })
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
      {list.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.sandbox.violationsEmpty}</p>
      ) : (
        <ul aria-label={d.sandbox.violations} className="flex flex-col gap-1">
          {list.map((v) => {
            const reason = d.sandbox.violationReasons[v.reason] || v.detail
            return (
              <li key={v.id} className="flex items-center gap-2 text-ui-sm">
                <Badge variant="outline" className="min-w-16 justify-center text-ui-xs">
                  {d.sandbox.violationKinds[v.kind]}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-fg">{v.target}</span>
                <span className="shrink-0 text-fg-muted">{reason}</span>
                <span className="shrink-0 text-fg-muted tabular-nums">
                  {fmt(d.sandbox.violationCount, { count: v.count, time: time.format(v.last) })}
                </span>
                {v.allowHost ? (
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
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </SettingsGroup>
  )
}
