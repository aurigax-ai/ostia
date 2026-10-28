import { currentScheme } from '@/lib/theme/colorScheme'
import type { ColorScheme } from '@/lib/theme/types'
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
