import type { RequirementsReport } from '@shared/systemRequirements'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { WarningNote } from './SettingsPanel'
import { Button } from './ui/button'

export function RequirementsNote({
  feature,
  body,
}: {
  feature: string
  body: string
}): JSX.Element | null {
  const d = useDict()
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const [report, setReport] = useState<RequirementsReport | null>(null)
  useEffect(() => {
    let live = true
    void window.pine.system.requirements(feature).then((next) => {
      if (live) setReport(next)
    })
    return () => {
      live = false
    }
  }, [feature])
  if (!report || report.missing.length === 0) return null
  const command = report.hint.command
  return (
    <WarningNote>
      <p>{fmt(body, { packages: report.hint.packages.join(', ') })}</p>
      {report.canInstall && workspaceId ? (
        <Button
          size="sm"
          className="mt-2"
          onClick={() => void window.pine.system.installRequirements(feature, workspaceId)}
        >
          {d.manager.install}
        </Button>
      ) : command ? (
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-ui-sm">{command}</code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigator.clipboard?.writeText(command)}
          >
            {d.manager.copyCommand}
          </Button>
        </div>
      ) : null}
    </WarningNote>
  )
}
