import { useEffect } from 'react'
import { currentTheme, useEffectiveTheme } from '../lib/theme'
import { monaco, monacoThemeName } from './setup'

export function initialMonacoTheme(): string {
  return monacoThemeName(currentTheme()?.appearance ?? 'dark')
}

export function useMonacoTheme(): void {
  const appearance = useEffectiveTheme()?.appearance ?? 'dark'
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeName(appearance))
  }, [appearance])
}
