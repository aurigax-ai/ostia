import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const STRINGS_DIR = 'src/shared/strings'

function keyOf(property) {
  if (!ts.isPropertyAssignment(property)) return null
  const { name } = property
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
}

export function sortedSource(text) {
  const file = ts.createSourceFile('catalogue.ts', text, ts.ScriptTarget.Latest, true)

  function span(node, start, end) {
    let out = ''
    let pos = start
    node.forEachChild((child) => {
      out += text.slice(pos, child.getFullStart()) + render(child)
      pos = child.end
    })
    return out + text.slice(pos, end)
  }

  function render(node) {
    if (!ts.isObjectLiteralExpression(node)) return span(node, node.getFullStart(), node.end)
    const { properties } = node
    const keys = properties.map(keyOf)
    if (properties.length < 2 || keys.includes(null)) return span(node, node.getFullStart(), node.end)
    const pieces = properties.map((property, index) => ({
      key: keys[index],
      text: span(property, property.getFullStart(), property.end),
    }))
    pieces.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const first = properties[0]
    const last = properties[properties.length - 1]
    return (
      text.slice(node.getFullStart(), first.getFullStart()) +
      pieces.map((piece) => piece.text).join(',') +
      text.slice(last.end, node.end)
    )
  }

  return render(file)
}

function catalogueFiles(root) {
  return readdirSync(join(root, STRINGS_DIR))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(STRINGS_DIR, name))
}

export function orderProblems(root) {
  return catalogueFiles(root)
    .filter((file) => {
      const text = readFileSync(join(root, file), 'utf8')
      return sortedSource(text) !== text
    })
    .map((file) => `unsorted: ${file}: keys must be sorted. Run node scripts/i18n.mjs sort.`)
}

export function sortCatalogues(root) {
  for (const file of catalogueFiles(root)) {
    const path = join(root, file)
    writeFileSync(path, sortedSource(readFileSync(path, 'utf8')))
  }
}
