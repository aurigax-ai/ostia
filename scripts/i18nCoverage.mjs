import { TRANSLATED } from './i18nCompare.mjs'

export const COMMENT_MARKER = '<!-- i18n-coverage -->'

function count(rows) {
  const counted = rows.filter((row) => row.status !== 'skip')
  return [counted.filter((row) => TRANSLATED.has(row.status)).length, counted.length]
}

export function coverageRows({ core, areaOf, packs, extensions }) {
  const rows = []
  for (const { language, rows: keys } of core) {
    rows.push({ id: `core:${language}`, label: 'Core', language, counts: count(keys) })
    const byArea = new Map()
    for (const row of keys) {
      const area = areaOf(row.key)
      byArea.set(area, [...(byArea.get(area) ?? []), row])
    }
    for (const area of [...byArea.keys()].sort()) {
      rows.push({
        id: `core:${area}:${language}`,
        label: `Core · ${area}`,
        language,
        counts: count(byArea.get(area)),
      })
    }
  }
  for (const pack of packs) {
    rows.push({
      id: `pack:${pack.id}:${pack.language}`,
      label: `Pack ${pack.id}`,
      language: pack.language,
      counts: count(pack.rows),
    })
  }
  for (const extension of extensions) {
    for (const result of extension.results) {
      rows.push({
        id: `extension:${extension.id}:${result.language}`,
        label: `Extension ${extension.id}`,
        language: result.language,
        counts: count(result.rows),
      })
    }
  }
  return rows
}

export function percent([translated, total]) {
  return total === 0 ? 100 : Math.floor((translated / total) * 1000) / 10
}

const shown = (value) => `${value.toFixed(1)}%`

function signed(points) {
  const text = points.toFixed(1)
  return points > 0 ? `+${text}` : text
}

function cell(counts, before) {
  const now = `${shown(percent(counts))} (${counts[0].toLocaleString('en-US')} of ${counts[1].toLocaleString('en-US')})`
  if (!before) return now
  return `${now}; main ${shown(percent(before))} (${signed(percent(counts) - percent(before))})`
}

export function baselineOf(rows, sha) {
  return { sha, rows: Object.fromEntries(rows.map((row) => [row.id, row.counts])) }
}

export function sameReasons(results) {
  const reasons = new Map()
  for (const row of results)
    if (row.status === 'same') reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1)
  return reasons
}

export function coverageMarkdown(rows, { baseline, same } = {}) {
  const languages = [...new Set(rows.map((row) => row.language))].sort()
  const labels = [...new Set(rows.map((row) => row.label))]
  const out = [COMMENT_MARKER, '### Translation coverage', '']
  out.push(
    `| Catalogue | ${languages.join(' | ')} |`,
    `|---|${languages.map(() => '---|').join('')}`,
  )
  for (const label of labels) {
    const cells = languages.map((language) => {
      const row = rows.find((r) => r.label === label && r.language === language)
      return row ? cell(row.counts, baseline?.rows[row.id]) : '–'
    })
    out.push(`| ${label} | ${cells.join(' | ')} |`)
  }
  out.push('')
  if (baseline) out.push(`Compared with main at ${baseline.sha.slice(0, 7)}.`)
  else out.push('No translation coverage of main to compare with yet.')
  if (same && same.size > 0) {
    const total = [...same.values()].reduce((a, b) => a + b, 0)
    const parts = [...same].map(([reason, n]) => `${reason} ${n}`).join(', ')
    out.push('', `Identical to English by design: ${total} (${parts}).`)
  }
  out.push(
    '',
    'Translated means present, with the same placeholders, and different from English unless listed in `i18n-allow.json`.',
  )
  return `${out.join('\n')}\n`
}
