import { useEffect } from 'react'
import { useScheme } from '@/lib/theme/colorScheme'
import { loadedMonaco } from './monacoLoader'

export function useMonacoTheme(): void {
  const scheme = useScheme('editor')
  useEffect(() => loadedMonaco()?.applyMonacoScheme(scheme), [scheme])
}
