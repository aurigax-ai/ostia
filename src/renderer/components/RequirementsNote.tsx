import type { RequirementsReport } from '@shared/systemRequirements'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { WarningNote } from './SettingsPanel'
import { Button } from './ui/button'

export function useRequirementsReport(feature: string): RequirementsReport | null {
  const [report, setReport] = useState<RequirementsReport | null>(null)
  useEffect(() => {
    let live = true
    void window.ostia.system.requirements(feature).then((next) => {
      if (live) setReport(next)
    })
    return () => {
      live = false
    }
  }, [feature])
  return report
}

export function RequirementsNote({
  feature,
  body,
}: {
  feature: string
  body: string
}): JSX.Element | null {
  return (
    <RequirementsNoteView feature={feature} body={body} report={useRequirementsReport(feature)} />
  )
}

export function RequirementsNoteView({
  feature,
  body,
  report,
}: {
  feature: string
  body: string
  report: RequirementsReport | null
}): JSX.Element | null {
  const d = useDict()
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  if (!report || report.missing.length === 0) return null
  const installHere = report.canInstall && workspaceId !== null
  const command = installHere ? null : report.hint.command
  const actions = installHere ? (
    <Button
      size="xs"
      onClick={() =>
        workspaceId && void window.ostia.system.installRequirements(feature, workspaceId)
      }
    >
      {d.manager.install}
    </Button>
  ) : command ? (
    <Button
      variant="outline"
      size="xs"
      onClick={() => void navigator.clipboard?.writeText(command)}
    >
      {d.manager.copyCommand}
    </Button>
  ) : null
  return (
    <WarningNote actions={actions}>
      <p>{fmt(body, { packages: report.hint.packages.join(', ') })}</p>
      {command ? <code className="block truncate font-mono text-ui-sm">{command}</code> : null}
    </WarningNote>
  )
}
