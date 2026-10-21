import { useEffect, useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { TextLink } from '@/components/common/TextLink'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { type ServerErrorCode, serverErrorText } from './serverText'

const POLL_MS = 2000

interface Flow {
  userCode: string
  verificationUri: string
}

function linkText(uri: string): string {
  try {
    const url = new URL(uri)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return uri
  }
}

export function ServerGithub(): JSX.Element {
  const d = useDict()
  const [flow, setFlow] = useState<Flow | null>(null)
  const [error, setError] = useState<ServerErrorCode | null>(null)

  useEffect(() => {
    if (!flow) return
    const timer = setInterval(() => {
      void window.ostia.server.githubPoll().then((poll) => {
        if (poll.state === 'pending') return
        setFlow(null)
        if (poll.state === 'error') setError(poll.error)
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [flow])

  const start = async (): Promise<void> => {
    setError(null)
    const result = await window.ostia.server.githubStart()
    if (result.ok) {
      setFlow({ userCode: result.userCode, verificationUri: result.verificationUri })
    } else {
      setError(result.error)
    }
  }

  const cancel = (): void => {
    setFlow(null)
    void window.ostia.server.githubCancel()
  }

  return (
    <ControlRow
      label={d.server.githubLabel}
      error={error ? serverErrorText(d, error) : null}
      errorId="server-github-error"
      below={
        flow ? (
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-fg-muted text-ui-sm">
            <span>{d.server.githubCode}</span>
            <MachineValue value={flow.userCode} />
            <TextLink onClick={() => void window.ostia.server.openVerification()}>
              {fmt(d.server.githubOpen, { link: linkText(flow.verificationUri) })}
            </TextLink>
            <output>{d.server.githubWaiting}</output>
          </span>
        ) : null
      }
    >
      {flow ? (
        <Button variant="ghost" size="sm" onClick={cancel}>
          {d.server.cancel}
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => void start()}>
          {d.server.githubStart}
        </Button>
      )}
    </ControlRow>
  )
}
