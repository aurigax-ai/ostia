import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { repoPath } from './i18nCatalog.mjs'

const SCANS = [
  { dir: 'src/renderer', file: /\.tsx$/, skip: [/^src\/renderer\/components\/ui\//], kind: 'renderer' },
  { dir: 'src/main', file: /\.ts$/, skip: [/^src\/main\/platform\/oldDirsPrompt\.ts$/], kind: 'main' },
]
const NOT_SOURCE = /\.(test|d)\.tsx?$/
const TEXT_ATTRIBUTES = new Set([
  'title',
  'aria-label',
  'aria-description',
  'placeholder',
  'alt',
  'label',
  'description',
  'tooltip',
  'confirmLabel',
  'cancelLabel',
])
const MAIN_PROPERTIES = new Set([
  'title',
  'body',
  'label',
  'buttons',
  'checkboxLabel',
  'buttonLabel',
  'nameFieldLabel',
  'tooltip',
  'confirmLabel',
  'cancelLabel',
])
const DIALOG_PROPERTIES = new Set(['message', 'detail'])
const MAIN_CALLS = new Set(['setToolTip', 'setTitle', 'showErrorBox'])
const DIALOG_CALLS = new Set(['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'Notification'])
const MACHINE_TAGS = new Set(['code', 'kbd', 'pre', 'samp', 'Kbd'])
const MACHINE_CLASS = 'font-mono'
const EXAMPLE_INPUT = /^[\w.:/@+~#$?=&{}%-]+$/
const MACHINE_TOKEN = /^[a-z0-9]+([-_.:/][a-z0-9]+)*$/
const MARKUP = /<\/[a-zA-Z]+>|<!doctype/i
const HIDDEN_MARKUP = /<(style|script)\b[^]*?<\/\1>/gi
const ANY_TAG = /<[^>]*>/g
const ENTITY = /&#?\w+;/g
const HOLE = '\u0001'

const hasLetter = (text) => /\p{L}/u.test(text)

function files(root, scan) {
  if (!existsSync(join(root, scan.dir))) return []
  return readdirSync(join(root, scan.dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && scan.file.test(entry.name) && !NOT_SOURCE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => ({ file, path: repoPath(root, file) }))
    .filter(({ path }) => !scan.skip.some((re) => re.test(path)))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function resultStrings(node) {
  if (!node) return []
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node]
  if (ts.isTemplateExpression(node)) return [node]
  if (ts.isParenthesizedExpression(node)) return resultStrings(node.expression)
  if (ts.isConditionalExpression(node)) return [...resultStrings(node.whenTrue), ...resultStrings(node.whenFalse)]
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return resultStrings(node.right)
    if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [...resultStrings(node.left), ...resultStrings(node.right)]
    }
  }
  return []
}

function literalText(node) {
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
  return node.text
}

function attributeValue(attribute) {
  const init = attribute.initializer
  if (!init) return []
  if (ts.isStringLiteral(init)) return [init]
  if (ts.isJsxExpression(init)) return resultStrings(init.expression)
  return []
}

function classMentions(element, word) {
  const attributes = ts.isJsxElement(element) ? element.openingElement.attributes : element.attributes
  for (const attribute of attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== 'className') continue
    let found = false
    const visit = (node) => {
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.split(/\s+/).includes(word)) found = true
      ts.forEachChild(node, visit)
    }
    if (attribute.initializer) visit(attribute.initializer)
    if (found) return true
  }
  return false
}

function tagName(element) {
  const opening = ts.isJsxElement(element) ? element.openingElement : element
  return opening.tagName.getText()
}

function insideMachineText(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at)) {
      if (MACHINE_TAGS.has(tagName(at)) || classMentions(at, MACHINE_CLASS)) return true
    }
  }
  return false
}

function scanRenderer(source, report) {
  const visit = (node) => {
    if (ts.isJsxText(node) && hasLetter(node.text) && !insideMachineText(node)) {
      report(node, node.text.trim().replace(/\s+/g, ' '), 'JSX text')
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      if (!insideMachineText(node)) {
        for (const literal of resultStrings(node.expression)) report(literal, literalText(literal), 'JSX text')
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText()
      if (TEXT_ATTRIBUTES.has(name)) {
        for (const literal of attributeValue(node)) {
          const text = literalText(literal)
          if (name === 'placeholder' && EXAMPLE_INPUT.test(text)) continue
          report(literal, text, `${name} attribute`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

function propertyName(node) {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined
}

function calleeName(node) {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

function isDialogOptions(literal) {
  if (literal.properties.some((p) => ts.isPropertyAssignment(p) && propertyName(p) === 'buttons')) return true
  const parent = literal.parent
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && DIALOG_CALLS.has(calleeName(parent) ?? '')
}

function markupText(parts) {
  const joined = parts.join(HOLE)
  if (!MARKUP.test(joined)) return undefined
  return joined.replace(HIDDEN_MARKUP, ' ').replace(ANY_TAG, ' ').replace(ENTITY, ' ').split(HOLE).join(' ')
}

const templateParts = (node) =>
  ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((s) => s.literal.text)] : [node.text]

function scanMain(source, report) {
  const reportUi = (literal, where) => {
    const text = literalText(literal)
    if (MACHINE_TOKEN.test(text.trim()) || text.trim().startsWith('<')) return
    report(literal, text, where)
  }
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const name = propertyName(node) ?? ''
      if (MAIN_PROPERTIES.has(name) || (DIALOG_PROPERTIES.has(name) && isDialogOptions(node.parent))) {
        const values = ts.isArrayLiteralExpression(node.initializer) ? node.initializer.elements : [node.initializer]
        for (const value of values) for (const literal of resultStrings(value)) reportUi(literal, `${name}:`)
      }
    } else if (ts.isCallExpression(node) && MAIN_CALLS.has(calleeName(node) ?? '')) {
      for (const argument of node.arguments) for (const literal of resultStrings(argument)) reportUi(literal, `${calleeName(node)}()`)
    } else if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = markupText(templateParts(node))
      if (text !== undefined && hasLetter(text)) report(node, text.trim().replace(/\s+/g, ' '), 'HTML text')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

export function checkLiterals(root, allow) {
  const problems = []
  for (const scan of SCANS) {
    for (const { file, path } of files(root, scan)) {
      const text = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scan.kind === 'renderer' ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const report = (node, value, where) => {
        if (!hasLetter(value) || allow.literalText(value)) return
        const { line } = source.getLineAndCharacterOfPosition(node.getStart())
        problems.push(
          `literal: ${path}:${line + 1}: ${where} ${JSON.stringify(value)} is user-visible text. Put it in src/shared/strings/ (en and zh-Hant) and read it through the dictionary.`,
        )
      }
      if (scan.kind === 'renderer') scanRenderer(source, report)
      else scanMain(source, report)
    }
  }
  return problems
}
