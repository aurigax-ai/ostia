import { playbookTextProblem, type TextProblem } from '@shared/agents/playbooks'
import { type JSX, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { useDict } from '@/lib/app/useDict'

export function PlaybookPrompt({
  text,
  label,
  placeholder,
  showProblems,
  onCommit,
}: {
  text: string
  label: string
  placeholder?: string
  showProblems: boolean
  onCommit: (text: string) => void
}): JSX.Element {
  const d = useDict()
  const [value, setValue] = useState(text)
  const problem: TextProblem | null =
    value === '' && !showProblems ? null : playbookTextProblem(value)
  const commit = (): void => {
    if (value !== text && playbookTextProblem(value) === null) onCommit(value)
  }
  return (
    <>
      <Textarea
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        className="mt-1 field-sizing-fixed h-80 resize-none font-mono text-ui-sm md:text-ui-sm"
      />
      {problem ? (
        <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
          {d.playbooks.textProblems[problem]}
        </p>
      ) : null}
    </>
  )
}
