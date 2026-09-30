import { useEffect } from 'react'
import { currentScheme, useScheme } from '../lib/colorScheme'
import type { ColorScheme } from '../plugins/types'
import { monacoThemeData, monacoThemeId } from './monacoTheme'
import { monaco } from './setup'

function defineSchemeTheme(scheme: ColorScheme): string {
  const id = monacoThemeId(scheme)
  monaco.editor.defineTheme(id, monacoThemeData(scheme))
  return id
}

export function initialMonacoTheme(): string {
  return defineSchemeTheme(currentScheme('editor'))
}

export function applyMonacoScheme(scheme: ColorScheme): void {
  monaco.editor.setTheme(defineSchemeTheme(scheme))
}

export function useMonacoTheme(): void {
  const scheme = useScheme('editor')
  useEffect(() => applyMonacoScheme(scheme), [scheme])
}
