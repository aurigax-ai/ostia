import type { ElevationStartResult } from '@shared/server/serverApi'
import { useRef, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'

const POLL_MS = 1500

type Waiting = Extract<ElevationStartResult, { ok: true }>

interface Outcome {
  ok: boolean
}

const needsElevation = (result: Outcome): boolean =>
  !result.ok && (result as { error?: string }).error === 'elevation-required'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function useElevated(): {
  run: <T extends Outcome>(action: () => Promise<T>) => Promise<T>
  prompt: JSX.Element | null
} {
  const d = useDict()
  const [waiting, setWaiting] = useState<Waiting | null>(null)
  const cancelled = useRef(false)

  const cancel = (): void => {
    cancelled.current = true
    setWaiting(null)
    void window.ostia.server.elevationCancel()
  }

  const run = async <T extends Outcome>(action: () => Promise<T>): Promise<T> => {
    const first = await action()
    if (!needsElevation(first)) return first
    const status = await window.ostia.server.status()
    const started = await window.ostia.server.elevationStart(
      status.provider === 'github' ? 'github' : 'approval',
    )
    if (!started.ok) return { ...first, error: started.error } as T
    cancelled.current = false
    setWaiting(started)
    while (!cancelled.current) {
      await pause(POLL_MS)
      if (cancelled.current) break
      const polled = await window.ostia.server.elevationPoll()
      if (polled.state === 'pending') continue
      setWaiting(null)
      return polled.state === 'done' ? action() : ({ ...first, error: polled.error } as T)
    }
    return first
  }

  const prompt = waiting ? (
    <Notice
      tone="info"
      actions={
        <Button variant="ghost" size="sm" onClick={cancel}>
          {d.server.elevationCancel}
        </Button>
      }
    >
      {waiting.kind === 'github'
        ? fmt(d.server.elevationGithub, { code: waiting.userCode })
        : d.server.elevationApproval}
    </Notice>
  ) : null

  return { run, prompt }
}
