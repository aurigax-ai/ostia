import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'

export function GitEmpty({
  title,
  hint,
  tone = 'muted',
}: { title: string; hint?: string; tone?: 'muted' | 'error' }): JSX.Element {
  return (
    <Empty className={`empty ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <EmptyHeader>
        <EmptyTitle
          className={`font-medium text-ui-base tracking-normal ${tone === 'error' ? 'text-attn-fg' : 'text-fg'}`}
        >
          {title}
        </EmptyTitle>
        {hint ? (
          <EmptyDescription className="text-fg-muted text-ui-sm">{hint}</EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}
