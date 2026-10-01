import { languageForPath } from '@shared/editorLanguages'

export function langFor(path: string): string {
  return languageForPath(path)
}
