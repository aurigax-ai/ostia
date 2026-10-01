export const EDITOR_LANGUAGE_ID_PATTERN = /^[a-z][a-z0-9+#-]{0,39}$/
export const PLAIN_TEXT_LANGUAGE = 'plaintext'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'shell',
  zsh: 'shell',
  bash: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  java: 'java',
  lua: 'lua',
}

export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function languageForPath(path: string): string {
  const extension = fileExtension(path)
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, extension)
    ? LANGUAGE_BY_EXTENSION[extension]
    : PLAIN_TEXT_LANGUAGE
}
