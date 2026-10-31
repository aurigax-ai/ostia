import type { PreviewTheme } from './htmlPreview'
import type { PublishOptions, ShareFinding, ShareView } from './shares'

export const PORTABLE_FORMAT = 'ostia-artifact/1'
const PORTABLE_MANIFEST_ID = 'ostia-artifact'

export const PORTABLE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export const PORTABLE_LIMITS = {
  sourceFileBytes: 1024 * 1024,
  sourceBytes: 4 * 1024 * 1024,
  seedFileBytes: 8 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  buildMs: 10_000,
} as const

export type PortableType = 'component' | 'page' | 'markdown' | 'svg' | 'json' | 'tables'
export type PortableMode = 'development' | 'production'
export type PortableAction = 'open' | 'save' | 'copy' | 'publish'

const TYPE_BY_EXTENSION: Readonly<Record<string, PortableType>> = {
  jsx: 'component',
  tsx: 'component',
  html: 'page',
  htm: 'page',
  md: 'markdown',
  markdown: 'markdown',
  svg: 'svg',
  json: 'json',
}

export function portableType(path: string | undefined): PortableType | null {
  const extension = /\.([^./\\]+)$/.exec(path ?? '')?.[1]?.toLowerCase()
  return extension ? (TYPE_BY_EXTENSION[extension] ?? null) : null
}

export function runsScripts(type: PortableType): boolean {
  return type === 'component' || type === 'page'
}

export function portableSandbox(type: PortableType): string {
  return runsScripts(type) ? 'allow-scripts' : 'allow-popups allow-popups-to-escape-sandbox'
}

export interface PortableManifest {
  format: typeof PORTABLE_FORMAT
  type: PortableType
  name: string
  built: string
  ostia: string
  libraries: string[]
  theme: PreviewTheme
  hash: string
  sources: Record<string, string>
}

export interface PortableDocument {
  body: string
  css: string
}

export interface PortableRequest {
  workspaceId: string
  path: string
  theme: PreviewTheme
  document?: PortableDocument
  publish?: PublishOptions
  awaitTables?: boolean
}

export type PortableResult =
  | { ok: true; share?: ShareView }
  | {
      ok: false
      reason:
        | 'cancelled'
        | 'failed'
        | 'sandboxed'
        | 'not-allowed'
        | 'too-large'
        | 'not-built'
        | 'no-tables'
        | 'findings'
        | 'scan-failed'
        | 'signed-out'
        | 'publish-off'
        | 'unreachable'
        | 'quota'
        | 'public-off'
        | 'never-off'
        | 'bad-options'
        | 'unavailable'
      message?: string
      findings?: ShareFinding[]
      findingsDigest?: string
    }

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function manifestJson(manifest: PortableManifest): string {
  return JSON.stringify(manifest).replace(/</g, '\\u003c')
}

const OUTER_STYLE =
  'html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}'

export function wrapPortable(document: string, manifest: PortableManifest): string {
  const title = escapeText(manifest.name)
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PORTABLE_CSP)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${OUTER_STYLE}</style>`,
    `<script type="application/json" id="${PORTABLE_MANIFEST_ID}">${manifestJson(manifest)}</script>`,
    '</head>',
    '<body>',
    `<iframe sandbox="${portableSandbox(manifest.type)}" allow="clipboard-write" title="${title.replace(/"/g, '&quot;')}" srcdoc="${escapeAttribute(document)}"></iframe>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function themeRule(theme: PreviewTheme): string {
  const vars = Object.entries(theme.vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return `:root{color-scheme:${theme.dark ? 'dark' : 'light'};${vars}}`
}

export function documentPage(
  title: string,
  body: string,
  css: string,
  theme: PreviewTheme,
): string {
  return [
    '<!doctype html>',
    `<html${theme.dark ? ' class="dark"' : ''}>`,
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeText(title)}</title>`,
    `<style>${themeRule(theme)}body{margin:0;background:var(--ostia-bg,Canvas);color:var(--ostia-fg,CanvasText);font-family:var(--ostia-font,system-ui,sans-serif)}</style>`,
    css ? `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>` : '',
    '</head>',
    `<body>${body}</body>`,
    '</html>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function portableFileName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? 'artifact'
  const stem = base.replace(/\.[^.]+$/, '') || 'artifact'
  return `${stem}.html`
}
