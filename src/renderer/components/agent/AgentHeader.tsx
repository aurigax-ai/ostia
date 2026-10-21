import { NotePencilIcon } from '@phosphor-icons/react'
import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'

export function AgentHeader({
  title,
  busy,
  onNew,
}: {
  title: string
  busy: boolean
  onNew: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <div className="flex min-h-9 items-center gap-1.5 border-line border-b px-2">
      <span className="min-w-0 truncate font-medium text-fg text-ui-sm">{title}</span>
      <span className="ml-auto" />
      <IconButton
        size="bar"
        icon={NotePencilIcon}
        label={d.agentPane.newSession}
        disabled={busy}
        onClick={onNew}
      />
    </div>
  )
}
