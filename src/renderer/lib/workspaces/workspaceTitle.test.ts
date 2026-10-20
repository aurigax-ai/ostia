import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sourceFiles } from '../../../../test/sourceFiles'
import { workspaceTitle } from './workspaceTitle'

describe('workspaceTitle', () => {
  it('prefers the custom name', () => {
    expect(workspaceTitle({ name: 'alpha', customName: 'Alpha' })).toBe('Alpha')
    expect(workspaceTitle({ name: 'alpha' })).toBe('alpha')
  })

  it('is the only place that falls back from customName to name', () => {
    const offenders = sourceFiles('src/renderer', '**/*.{ts,tsx}')
      .filter((file) => !file.endsWith('workspaceTitle.ts'))
      .filter((file) => /customName \?\? /.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})
