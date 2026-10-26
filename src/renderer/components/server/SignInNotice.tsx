import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { useDict } from '@/lib/app/useDict'
import { useUIStore } from '@/stores/app/uiStore'

export function SignInNotice({ text }: { text: string }): JSX.Element {
  const d = useDict()
  return (
    <Notice
      tone="info"
      actions={
        <TextLink
          size="sm"
          onClick={() => useUIStore.getState().openSettings('sync', { signIn: true })}
        >
          {d.server.signIn}
        </TextLink>
      }
    >
      {text}
    </Notice>
  )
}
