import { useEffect } from 'react'
import { currentScheme, useScheme } from '../lib/colorScheme'
import type { ColorScheme } from '../plugins/types'
import { monacoThemeData, monacoThemeId } from './monacoTheme'
import { monaco } from './setup'

let applied: string | null = null

export function applyMonacoScheme(scheme: ColorScheme): void {
  const id = monacoThemeId(scheme)
  const data = monacoThemeData(scheme)
  const key = `${id}\n${JSON.stringify(data)}`
  if (key === applied) return
  applied = key
  monaco.editor.defineTheme(id, data)
  monaco.editor.setTheme(id)
}

export function ensureMonacoTheme(): void {
  if (applied === null) applyMonacoScheme(currentScheme('editor'))
}

export function useMonacoTheme(): void {
  const scheme = useScheme('editor')
  useEffect(() => applyMonacoScheme(scheme), [scheme])
}
