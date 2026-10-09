import { MenuItem } from '@/components/common/Menu'
import { SplitButton, SplitButtonMenu } from '@/components/common/SplitButton'
import { Button } from '@/components/ui/button'
import { useDict } from '@/i18n/useDict'
import { useApprovalsStore } from '@/stores/approvalsStore'
import type { Dict } from '@shared/app/dict'
import {
  type ApprovalAnswer,
  type ApprovalKind,
  type ApprovalRequest,
  offeredAnswers,
} from '@shared/permissions/approvals'

function answerLabel(d: Dict, kind: ApprovalKind, answer: ApprovalAnswer): string {
  if (answer === 'once') return d.approvals.allowOnce
  if (answer === 'workspace') return d.approvals.allowWorkspace
  if (answer === 'always') return d.approvals.allowAlways
  return kind === 'capability' ? d.approvals.allowSession : d.approvals.allowUntilRestart
}

export function ApprovalActions({
  request,
  size,
}: {
  request: ApprovalRequest
  size: 'sm' | 'xs'
}): JSX.Element {
  const d = useDict()
  const answer = useApprovalsStore((s) => s.answer)
  const kind = request.kind ?? 'capability'
  const [main, ...more] = offeredAnswers(request).filter((a) => a !== 'deny')
  const pick = (choice: ApprovalAnswer): void => void answer(request.id, choice)
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" size={size} onClick={() => pick('deny')}>
        {d.approvals.deny}
      </Button>
      {main ? (
        <SplitButton
          label={d.approvals.allowChoices}
          main={
            <Button size={size} onClick={() => pick(main)}>
              {answerLabel(d, kind, main)}
            </Button>
          }
        >
          {more.length > 0 ? (
            <SplitButtonMenu label={d.approvals.allowChoices} size={size}>
              {more.map((choice) => (
                <MenuItem key={choice} onClick={() => pick(choice)}>
                  {answerLabel(d, kind, choice)}
                </MenuItem>
              ))}
            </SplitButtonMenu>
          ) : null}
        </SplitButton>
      ) : null}
    </div>
  )
}
