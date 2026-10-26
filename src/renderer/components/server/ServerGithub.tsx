import { useEffect, useState } from 'react'
import { MachineValue } from '@/components/common/MachineValue'
import { TextLink } from '@/components/common/TextLink'
import { fmt, useDict } from '@/lib/app/useDict'
import type { ServerErrorCode } from './serverText'

const POLL_MS = 2000

interface Flow {
  userCode: string
  verificationUri: string
}

export interface GithubSignIn {
  flow: Flow | null
  error: ServerErrorCode | null
  start: () => Promise<void>
  cancel: () => void
}

function linkText(uri: string): string {
  try {
    const url = new URL(uri)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return uri
  }
}

export function useGithubSignIn(): GithubSignIn {
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
    if (result.ok) setFlow({ userCode: result.userCode, verificationUri: result.verificationUri })
    else setError(result.error)
  }

  const cancel = (): void => {
    setFlow(null)
    void window.ostia.server.githubCancel()
  }

  return { flow, error, start, cancel }
}

export function GithubWaitLine({ flow }: { flow: Flow }): JSX.Element {
  const d = useDict()
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2 text-fg-muted text-ui-sm">
      <span>{d.server.githubCode}</span>
      <MachineValue value={flow.userCode} />
      <TextLink onClick={() => void window.ostia.server.openVerification()}>
        {fmt(d.server.githubOpen, { link: linkText(flow.verificationUri) })}
      </TextLink>
      <output>{d.server.githubWaiting}</output>
    </span>
  )
}
