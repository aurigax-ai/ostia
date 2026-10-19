import type {
  SnippetEntry,
  SnippetListing,
} from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from '../common/args'
import { fail, failUsage } from '../common/failure'
import { tsvLine } from '../common/lineField'

function describeSnippet(w: SnippetEntry): string {
  const lines = [`name: ${w.name}`, `source: ${w.source} (${w.origin})`]
  if (w.description) lines.push(`description: ${w.description}`)
  if (w.tags.length > 0) lines.push(`tags: ${w.tags.join(', ')}`)
  lines.push(`command: ${w.command}`)
  if (w.arguments.length > 0) {
    lines.push('arguments:')
    for (const a of w.arguments) {
      const about = a.description ? ` — ${a.description}` : ''
      const fallback = a.defaultValue !== undefined ? ` (default: ${a.defaultValue})` : ''
      lines.push(`  ${a.name}${about}${fallback}`)
    }
  }
  if (w.shells) lines.push(`shells: ${w.shells.join(', ')}`)
  if (w.author) lines.push(`author: ${w.author}`)
  if (w.sourceUrl) lines.push(`source_url: ${w.sourceUrl}`)
  return lines.join('\n')
}

export async function runSnippetVerb(conn: MessageConnection): Promise<void> {
  const [sub, ...rest] = process.argv.slice(3)
  const { positional, booleans } = parseArgs(rest, {
    booleans: { json: '--json' },
    unknown: 'keep',
  })
  const { json } = booleans
  const name = positional.join(' ').trim()
  if (sub !== 'list' && !(sub === 'show' && name)) return failUsage('snippet')
  const listing = await conn.sendRequest<SnippetListing>('snippet.list')
  if (sub === 'list') {
    if (json) {
      console.log(JSON.stringify(listing))
      return
    }
    for (const w of listing.snippets) {
      console.log(tsvLine([w.name, `${w.source}:${w.origin}`, w.command]))
    }
    for (const p of listing.problems) {
      console.error(`ostia snippet: couldn't read ${p.source}:${p.origin}: ${p.error}`)
    }
    return
  }
  const matches = listing.snippets.filter((w) => w.name === name)
  if (matches.length === 0) {
    fail(`ostia snippet show: no snippet named '${name}'`)
    return
  }
  console.log(json ? JSON.stringify(matches) : matches.map(describeSnippet).join('\n\n'))
}
