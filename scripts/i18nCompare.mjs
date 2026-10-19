import { ALLOW_FILE } from './i18nAllow.mjs'
import { hasText, placeholders } from './i18nCatalog.mjs'

export const TRANSLATED = new Set(['translated', 'same'])

const list = (names) => (names.length ? names.join(', ') : 'none')

export function compareCatalog({ source, target, scope, label, fileOf, allow, quiet = false }) {
  const rows = []
  const problems = []
  const report = (problem) => {
    if (!quiet) problems.push(problem)
  }
  for (const [key, text] of source) {
    if (typeof text !== 'string' || !hasText(text)) {
      rows.push({ key, status: 'skip' })
      continue
    }
    const value = target.get(key)
    if (typeof value !== 'string' || !value.trim()) {
      const allowed = allow.same(scope, key)
      if (allowed) {
        rows.push({ key, status: 'same', reason: allowed.reason })
        continue
      }
      rows.push({ key, status: 'missing' })
      report(`missing: ${label} ${key}: no translation. Add it to ${fileOf(key)}.`)
    } else if (placeholders(value).join() !== placeholders(text).join()) {
      rows.push({ key, status: 'placeholder' })
      report(
        `placeholder: ${label} ${key}: en has ${list(placeholders(text))}, the translation has ${list(placeholders(value))}. Use the same placeholders in ${fileOf(key)}.`,
      )
    } else if (value === text) {
      const allowed = allow.same(scope, key)
      rows.push({ key, status: allowed ? 'same' : 'copied', reason: allowed?.reason })
      if (!allowed) {
        report(
          `copied: ${label} ${key} = ${JSON.stringify(value)}: translate it in ${fileOf(key)}, or list it under same.${scope} in ${ALLOW_FILE} if it is a product or protocol name.`,
        )
      }
    } else {
      rows.push({ key, status: 'translated' })
    }
  }
  for (const [key, value] of target) {
    if (!source.has(key))
      problems.push(`extra: ${label} ${key}: not in en. Remove it from ${fileOf(key)}.`)
    else if (typeof value !== 'string')
      problems.push(`extra: ${label} ${key}: not a string. Write it as text in ${fileOf(key)}.`)
  }
  return { rows, problems }
}
