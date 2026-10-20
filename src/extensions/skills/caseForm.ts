import { call, h } from '@aurigax-ai/ostia-extension-sdk/panel'
import { button, field, t } from './panelKit'

export interface CaseFormContext {
  rule: string
  problem: string
  setProblem: (problem: string) => void
  saved: () => Promise<void>
  cancel: () => void
}

function parseFiles(text: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = []
  for (const block of text.split(/^=== /m).slice(1)) {
    const newline = block.indexOf('\n')
    const path = (newline < 0 ? block : block.slice(0, newline)).trim()
    if (path) files.push({ path, content: newline < 0 ? '' : block.slice(newline + 1) })
  }
  return files
}

export function caseFormBody(ctx: CaseFormContext): HTMLElement {
  const prompt = h('textarea', { name: 'prompt', rows: '3' }) as HTMLTextAreaElement
  const files = h('textarea', {
    name: 'files',
    rows: '5',
    placeholder: t('case.filesPlaceholder'),
  }) as HTMLTextAreaElement
  const value = h('textarea', { name: 'check', rows: '2' }) as HTMLTextAreaElement
  const kinds = (['matches', 'absent'] as const).map((kind, i) =>
    h(
      'label',
      { class: 'choice' },
      h('input', { type: 'radio', name: 'kind', value: kind, checked: i === 0 }),
      t(`eval.check.${kind}`),
    ),
  )
  const kind = (): string =>
    (kinds.map((l) => l.querySelector('input')).find((i) => i?.checked) as HTMLInputElement).value
  return h(
    'div',
    { class: 'body' },
    h(
      'div',
      { class: 'details', 'data-pane': 'case' },
      field(t('case.prompt'), prompt),
      field(t('case.files'), files),
      field(t('case.check'), h('div', {}, ...kinds)),
      field(t('case.checkValue'), value),
      ctx.problem ? h('p', { class: 'error' }, ctx.problem) : null,
      h(
        'div',
        { class: 'buttons' },
        button(
          t('save'),
          async () => {
            const res = await call('save-case', {
              rule: ctx.rule,
              prompt: prompt.value,
              files: parseFiles(files.value),
              check: { kind: kind(), value: value.value },
            })
            if (!res.ok) {
              ctx.setProblem(t(`problem.${res.error}`))
              return
            }
            ctx.setProblem('')
            await ctx.saved()
          },
          true,
        ),
        button(t('cancel'), ctx.cancel),
      ),
    ),
  )
}
