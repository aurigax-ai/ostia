import { type JSX, useEffect, useState } from 'react'
import { TextLink } from '@/components/common/TextLink'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import { ServerAddressField } from './ServerAddressField'
import { GithubWaitLine, useGithubSignIn } from './ServerGithub'
import { ServerInviteField } from './ServerInviteField'
import { serverErrorText } from './serverText'
import { useServerOffer, useServerStatus } from './useServerStatus'

const LINK = 'h-auto px-0'

function SignInBody({ onClose }: { onClose: () => void }): JSX.Element {
  const d = useDict()
  const status = useServerStatus()
  const offered = useServerOffer(status.url)
  const github = useGithubSignIn()
  const [inviteShown, setInviteShown] = useState(false)
  const [addressShown, setAddressShown] = useState(false)
  const offer = offered.state === 'ready' ? offered.offer : null
  const withGithub = offer?.github === true
  const inviteField = offer?.invite === true && (inviteShown || !withGithub)
  const addressField = addressShown || status.url === null
  const error = github.error ?? (offered.state === 'error' ? offered.error : null)
  const body = github.flow !== null || inviteField || addressField || error !== null

  useEffect(() => {
    if (status.signedIn) onClose()
  }, [status.signedIn, onClose])

  return (
    <>
      <DialogHeader>
        <DialogTitle>{d.server.signIn}</DialogTitle>
        <DialogDescription>
          {status.host ? fmt(d.server.signInDesc, { host: status.host }) : d.server.noServerDesc}
        </DialogDescription>
      </DialogHeader>
      {body ? (
        <div className="flex flex-col gap-3">
          {github.flow ? <GithubWaitLine flow={github.flow} /> : null}
          {inviteField ? <ServerInviteField /> : null}
          {addressField ? <ServerAddressField url={status.url} /> : null}
          {error ? (
            <p role="alert" className="text-attn-fg text-ui-sm">
              {serverErrorText(d, error)}
            </p>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <span className="flex items-center gap-4 sm:mr-auto">
          {withGithub && offer?.invite && !inviteShown ? (
            <TextLink size="sm" className={LINK} onClick={() => setInviteShown(true)}>
              {d.server.useInvite}
            </TextLink>
          ) : null}
          {addressField ? null : (
            <TextLink size="sm" className={LINK} onClick={() => setAddressShown(true)}>
              {d.server.changeServer}
            </TextLink>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            github.cancel()
            onClose()
          }}
        >
          {d.server.cancel}
        </Button>
        {withGithub ? (
          <Button size="sm" disabled={github.flow !== null} onClick={() => void github.start()}>
            {d.server.githubStart}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  )
}

export function ServerSignInDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        {open ? <SignInBody onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}
