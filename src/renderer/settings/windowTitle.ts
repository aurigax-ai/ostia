export const DEFAULT_WINDOW_TITLE = '{workspace} · {product}'
export const WINDOW_TITLE_MAX = 120

export interface WindowTitleValues {
  product: string
  workspace?: string
  pane?: string
  cwd?: string
}

const EDGE_SEPARATORS = /^[\s·—–\-|:]+|[\s·—–\-|:]+$/g

export function parseWindowTitle(raw: unknown): string {
  return typeof raw === 'string' && raw.length <= WINDOW_TITLE_MAX ? raw : DEFAULT_WINDOW_TITLE
}

export function formatWindowTitle(template: string, values: WindowTitleValues): string {
  const filled = template.replace(
    /\{(product|workspace|pane|cwd)\}/g,
    (_m, key: keyof WindowTitleValues) => values[key] ?? '',
  )
  return filled.replace(EDGE_SEPARATORS, '') || values.product
}
