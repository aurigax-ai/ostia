import type { ViewerPortableTables } from '@aurigax-ai/ostia-extension-sdk/contract/fileViewers'
import type { PortableDocument } from '../../shared/artifacts/portable'

export type PublishedTables = ViewerPortableTables | 'too-large' | null

const TABLES_CSS = [
  'body{margin:0;padding:8px 12px 24px;background:var(--ostia-bg);color:var(--ostia-fg);font-family:var(--ostia-font)}',
  'h2{margin:16px 0 4px;font-size:14px;font-weight:600}',
  'table{border-collapse:collapse;font-family:var(--ostia-font-mono);font-size:12px}',
  'th,td{max-width:480px;padding:3px 10px;overflow:hidden;border:1px solid var(--ostia-line);text-align:left;text-overflow:ellipsis;white-space:nowrap}',
  'th{position:sticky;top:0;background:var(--ostia-surface)}',
].join('')

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cells(tag: 'th' | 'td', values: string[]): string {
  return values.map((value) => `<${tag}>${escapeHtml(value)}</${tag}>`).join('')
}

export function tablesDocument(published: ViewerPortableTables): PortableDocument {
  const body = published.tables
    .map(
      (table) =>
        `<section><h2>${escapeHtml(table.name)}</h2><table><thead><tr>${cells('th', table.columns)}</tr></thead><tbody>${table.rows
          .map((row) => `<tr>${cells('td', row)}</tr>`)
          .join('')}</tbody></table></section>`,
    )
    .join('')
  return { body, css: TABLES_CSS }
}
