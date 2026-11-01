import { type JSX, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDict } from '@/lib/app/useDict'
import { type ServerErrorCode, serverErrorText } from './serverText'

export function ServerInviteField(): JSX.Element {
  const d = useDict()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ServerErrorCode | null>(null)

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ostia.server.signInWithInvite(code)
      if (result.ok) setCode('')
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-fg-muted text-ui-sm">{d.server.inviteDesc}</p>
      <div className="flex items-center gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && code.trim() !== '' && !busy) void signIn()
          }}
          spellCheck={false}
          autoComplete="off"
          aria-label={d.server.inviteLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'server-invite-error' : undefined}
          className="h-7 min-w-0 flex-1 font-mono"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || code.trim() === ''}
          onClick={() => void signIn()}
        >
          {d.server.inviteSignIn}
        </Button>
      </div>
      {error ? (
        <p id="server-invite-error" role="alert" className="text-attn-fg text-ui-sm">
          {serverErrorText(d, error)}
        </p>
      ) : null}
    </div>
  )
}
