import { type JSX, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { useDict } from '@/lib/app/useDict'
import { ServerSignInDialog } from './ServerSignInDialog'

export function SignInNotice({ text }: { text: string }): JSX.Element {
  const d = useDict()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Notice
        tone="info"
        actions={
          <TextLink size="sm" onClick={() => setOpen(true)}>
            {d.server.signIn}
          </TextLink>
        }
      >
        {text}
      </Notice>
      <ServerSignInDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
