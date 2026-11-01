import type { ClaudeAccountView } from '@shared/claudeAccounts/claudeAccounts'
import { type JSX, useEffect, useRef, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useClaudeAccounts } from '@/lib/agents/useClaudeAccounts'
import { fmt, useDict } from '@/lib/app/useDict'

interface Props {
  account: ClaudeAccountView | null
  onClose: () => void
}

export function ClaudeSignInDialog({ account, onClose }: Props): JSX.Element {
  const d = useDict().claudeAccounts
  const { signIn } = useClaudeAccounts()
  const { claudeAccounts } = window.ostia
  const [code, setCode] = useState('')
  const [invalid, setInvalid] = useState(false)
  const started = useRef(false)
  const target = account?.id ?? null

  const retry = (): void => {
    setCode('')
    setInvalid(false)
    void claudeAccounts.beginSignIn(target).then((outcome) => {
      if (outcome !== 'started') onClose()
    })
  }

  useEffect(() => {
    if (signIn !== 'idle') started.current = true
    else if (started.current) onClose()
  }, [signIn, onClose])

  const cancel = (): void => {
    void claudeAccounts.cancelSignIn()
    onClose()
  }
  const submit = async (): Promise<void> => {
    setInvalid((await claudeAccounts.submitSignInCode(code)) === 'invalid')
  }
  const failed = signIn === 'failed' || signIn === 'mismatch'
  const working = signIn === 'working'

  return (
    <Dialog open onOpenChange={(open) => !open && !working && cancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{d.signInTitle}</DialogTitle>
          <DialogDescription>{d.signInBody}</DialogDescription>
        </DialogHeader>
        {failed ? (
          <Notice
            tone="error"
            actions={
              <Button variant="ghost" size="sm" onClick={retry}>
                {d.signInRetry}
              </Button>
            }
          >
            {signIn === 'mismatch'
              ? fmt(d.signInMismatch, { email: account?.email ?? '' })
              : d.signInFailed}
          </Notice>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={working} onClick={() => void claudeAccounts.openSignIn()}>
                {d.signInOpen}
              </Button>
              <span className="text-fg-muted text-ui-sm">
                {working ? d.signInWorking : d.signInWaiting}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="claude-signin-code" className="text-fg-muted text-ui-xs">
                {d.signInPasteLabel}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="claude-signin-code"
                  value={code}
                  disabled={working}
                  aria-invalid={invalid}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setCode(e.target.value)
                    setInvalid(false)
                  }}
                  placeholder={d.signInCodePlaceholder}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={working || code.trim() === ''}
                  onClick={() => void submit()}
                >
                  {d.signInSubmit}
                </Button>
              </div>
              {invalid ? <Notice tone="error">{d.signInInvalid}</Notice> : null}
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={working} onClick={cancel}>
            {d.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
