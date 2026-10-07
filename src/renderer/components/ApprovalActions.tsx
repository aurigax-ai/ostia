import { CaretDownIcon } from '@phosphor-icons/react'
import {
  type ApprovalAnswer,
  type ApprovalKind,
  type ApprovalRequest,
  offeredAnswers,
} from '@shared/approvals'
import type { Dict } from '../i18n/dict'
import { useDict } from '../i18n/useDict'
import { useApprovalsStore } from '../stores/approvalsStore'
import { DropdownMenu, MenuItem } from './Menu'
import { Button } from './ui/button'
import { ButtonGroup, ButtonGroupSeparator } from './ui/button-group'

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
        <ButtonGroup aria-label={d.approvals.allowChoices}>
          <Button size={size} onClick={() => pick(main)}>
            {answerLabel(d, kind, main)}
          </Button>
          {more.length > 0 ? (
            <>
              <ButtonGroupSeparator className="bg-on-brand/25" />
              <DropdownMenu
                trigger={
                  <Button
                    size={size === 'sm' ? 'icon-sm' : 'icon-xs'}
                    aria-label={d.approvals.allowChoices}
                  >
                    <CaretDownIcon aria-hidden />
                  </Button>
                }
              >
                {more.map((choice) => (
                  <MenuItem key={choice} onClick={() => pick(choice)}>
                    {answerLabel(d, kind, choice)}
                  </MenuItem>
                ))}
              </DropdownMenu>
            </>
          ) : null}
        </ButtonGroup>
      ) : null}
    </div>
  )
}
