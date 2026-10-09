import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/i18n/useDict'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { InfoIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { MissingRequirement, RequirementsReport } from '@shared/app/systemRequirements'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface Requirements {
  report: RequirementsReport | null
  installing: boolean
  install: (workspaceId: string) => void
}

export function useRequirements(feature: string | null): Requirements {
  const [report, setReport] = useState<RequirementsReport | null>(null)
  const [installing, setInstalling] = useState(false)
  const latest = useRef(0)
  const check = useCallback(() => {
    const ticket = ++latest.current
    if (!feature) {
      setReport(null)
      return
    }
    void window.ostia.system.requirements(feature).then((next) => {
      if (latest.current === ticket) setReport(next)
    })
  }, [feature])
  useEffect(() => {
    check()
    window.addEventListener('focus', check)
    return () => {
      latest.current++
      window.removeEventListener('focus', check)
    }
  }, [check])
  const install = useCallback(
    (workspaceId: string) => {
      if (!feature) return
      setInstalling(true)
      void window.ostia.system.installRequirements(feature, workspaceId).finally(() => {
        setInstalling(false)
        check()
      })
    },
    [feature, check],
  )
  return { report, installing, install }
}

export function RequirementsNote({
  feature,
  body,
}: {
  feature: string
  body: string
}): JSX.Element | null {
  return <RequirementsNoteView body={body} requirements={useRequirements(feature)} />
}

function foundText(d: Dict, missing: MissingRequirement): string {
  const t = d.requirements
  if (missing.found) return fmt(t.found, { program: missing.program, version: missing.found })
  if (missing.needs) return fmt(t.tooOld, { program: missing.program })
  return fmt(t.notInstalled, { program: missing.program })
}

export function RequirementsNoteView({
  body,
  requirements,
}: {
  body: string
  requirements: Requirements
}): JSX.Element | null {
  const d = useDict()
  const t = d.requirements
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const { report, installing, install } = requirements
  if (!report || report.missing.length === 0) return null
  const packages = report.hint.packages.join(', ')
  const installHere = report.canInstall && workspaceId !== null
  const command = report.hint.command
  return (
    <div role="note" className="mt-1 flex items-start gap-2 text-fg-muted text-ui-sm">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{fmt(body, { packages })}</p>
        {report.missing.map((m) => (
          <p key={m.program}>{foundText(d, m)}</p>
        ))}
        {installing ? <p>{t.installing}</p> : null}
        {installHere ? null : (
          <p>{command ? t.cantInstall : fmt(t.cantInstallNoCommand, { packages })}</p>
        )}
        {!installHere && command ? (
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">{command}</code>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void navigator.clipboard?.writeText(command)}
            >
              {t.copyCommand}
            </Button>
          </div>
        ) : null}
      </div>
      {installHere ? (
        <Button
          variant="secondary"
          size="xs"
          className="shrink-0"
          disabled={installing}
          onClick={() => workspaceId && install(workspaceId)}
        >
          {fmt(t.install, { packages })}
        </Button>
      ) : null}
    </div>
  )
}
