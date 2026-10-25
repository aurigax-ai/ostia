import { cn } from '@/lib/utils'

export function StatusText({ text, ok }: { text: string; ok: boolean }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 text-fg-muted text-ui-sm">
      <span className={cn('dot', ok && 'done')} />
      <span className="min-w-0 truncate">{text}</span>
    </span>
  )
}
