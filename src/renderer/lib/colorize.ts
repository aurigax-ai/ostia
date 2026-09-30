const COLORIZE_MAX = 200_000

const ALIASES: Record<string, string> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  shellscript: 'shell',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  ps1: 'powershell',
  kt: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
}

export function monacoLanguageId(fence: string, known: readonly string[]): string | null {
  const name = fence.trim().toLowerCase()
  if (!name) return null
  const id = ALIASES[name] ?? name
  return known.includes(id) ? id : null
}

export async function colorizeCode(code: string, fence: string): Promise<string | null> {
  if (!fence.trim() || code.length > COLORIZE_MAX) return null
  try {
    const { monaco } = await import('../monaco/setup')
    const known = monaco.languages.getLanguages().map((l) => l.id)
    const id = monacoLanguageId(fence, known)
    if (!id) return null
    return await monaco.editor.colorize(code, id, { tabSize: 2 })
  } catch {
    return null
  }
}
