import { RUNTIME_PREFIX, TAILWIND_RUNTIME, runtimeImportMap } from '../../shared/artifactRuntime'
import { type PreviewTheme, SHELL_MODULE_PATH } from '../../shared/htmlPreview'
import shellSource from './previewShellModule.txt?raw'

export const ENTRY_MODULE_PATH = '/__ostia_entry.js'

function themeRule(theme: PreviewTheme): string {
  const vars = Object.entries(theme.vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return `:root{color-scheme:${theme.dark ? 'dark' : 'light'};${vars}}`
}

export function shellPage(nonce: string, theme: PreviewTheme): string {
  const importMap = JSON.stringify(runtimeImportMap()).replace(/</g, '\\u003c')
  return [
    '<!doctype html>',
    `<html${theme.dark ? ' class="dark"' : ''}>`,
    '<head>',
    '<meta charset="utf-8">',
    `<style>${themeRule(theme)}body{margin:0;background:var(--ostia-bg,Canvas);color:var(--ostia-fg,CanvasText);font-family:var(--ostia-font,system-ui,sans-serif)}</style>`,
    `<script type="importmap" nonce="${nonce}">${importMap}</script>`,
    `<script nonce="${nonce}" src="${RUNTIME_PREFIX}${TAILWIND_RUNTIME.file}"></script>`,
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="module" nonce="${nonce}" src="${SHELL_MODULE_PATH}"></script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export function shellModule(): string {
  return shellSource.replace('"__ENTRY__"', JSON.stringify(ENTRY_MODULE_PATH))
}
