import { type RenderResult, act, render } from '@testing-library/react'
import type { ReactElement } from 'react'

export async function renderSettled(ui: ReactElement): Promise<RenderResult> {
  let result: RenderResult | null = null
  await act(async () => {
    result = render(ui)
  })
  if (!result) throw new Error('render did not run')
  return result
}
