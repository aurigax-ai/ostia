import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const RENDERER = resolve(process.cwd(), 'src/renderer')
const PANEL = resolve(RENDERER, 'components/settings/SettingsPanel.tsx')

const DRIFT = {
  separator: (text: string) => text.includes('<Separator'),
  negativeMargin: (text: string) => /[\s"'`:]-mx-\d/.test(text),
  divide: (text: string) => text.includes('divide-y'),
  handHeading: (text: string) => /<h[234]\b/.test(text),
  handSection: (text: string) => /<section\b/.test(text),
  handRow: (text: string) => text.includes('justify-between'),
}

type Rule = keyof typeof DRIFT | 'root'

const KNOWN_OFFENDERS: Record<string, Rule[]> = {
  'components/agents/ApprovalCard.tsx': ['handSection'],
  'components/app/AboutSection.tsx': ['root', 'handHeading', 'handSection'],
  'components/extensions/ExtensionAgentPlugin.tsx': ['handSection'],
  'components/extensions/ExtensionConnections.tsx': ['handSection'],
  'components/gateway/GatewayPairing.tsx': ['handRow'],
  'components/keyboard/BindingDetail.tsx': ['handSection'],
  'components/keyboard/ChangesView.tsx': ['handRow'],
  'components/keyboard/KeymapCombo.tsx': ['handHeading', 'handSection'],
  'components/scriptTokens/ScriptTokensSection.tsx': ['root'],
  'components/scriptTokens/TokenDetail.tsx': ['handHeading', 'handRow'],
  'components/scriptTokens/TokenDialog.tsx': ['negativeMargin', 'handRow'],
  'components/settings/PrivacySection.tsx': ['handHeading'],
  'components/settings/PromptSection.tsx': ['handSection'],
  'components/settings/TelemetryConsentDialog.tsx': ['handHeading'],
  'components/settings/TelemetryReportsDialog.tsx': ['handHeading', 'handSection'],
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
}

function importSpecs(source: ts.SourceFile): Map<string, string> {
  const specs = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      specs.set(element.name.text, statement.moduleSpecifier.text)
    }
  }
  return specs
}

function resolveSpec(spec: string, from: string): string | null {
  const base = spec.startsWith('@/')
    ? resolve(RENDERER, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(from), spec)
      : null
  if (!base) return null
  for (const candidate of [`${base}.tsx`, `${base}.ts`]) if (existsSync(candidate)) return candidate
  return null
}

function renderedPages(): { name: string; file: string }[] {
  const panelSource = parse(PANEL)
  const specs = importSpecs(panelSource)
  const text = readFileSync(PANEL, 'utf8')
  const start = text.indexOf('const page = ')
  const end = text.indexOf('if (!searching)')
  const names = new Set([...text.slice(start, end).matchAll(/<([A-Z]\w+)/g)].map((m) => m[1]))
  const pages: { name: string; file: string }[] = []
  for (const name of names) {
    const spec = specs.get(name)
    const file = spec ? resolveSpec(spec, PANEL) : null
    if (file) pages.push({ name, file })
  }
  return pages
}

function closure(entry: string): string[] {
  const folder = dirname(entry)
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of importSpecs(parse(file)).values()) {
      const next = resolveSpec(spec, file)
      if (next && dirname(next) === folder && !next.includes('.test.')) queue.push(next)
    }
  }
  return [...seen]
}

function isNull(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword
}

function mentionsPage(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
      n.tagName.getText() === 'SettingsPage'
    ) {
      found = true
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

function delegatesToRootedPage(tag: string, file: string, depth: number): boolean {
  if (depth > 3 || !/^[A-Z]/.test(tag)) return false
  const spec = importSpecs(parse(file)).get(tag)
  const target = spec ? resolveSpec(spec, file) : file
  return target !== null && entryIsRooted(tag, target, depth + 1)
}

function rooted(node: ts.Node, file: string, depth: number): boolean {
  if (ts.isParenthesizedExpression(node)) return rooted(node.expression, file, depth)
  if (ts.isConditionalExpression(node)) {
    const branch = (b: ts.Expression): boolean => isNull(b) || rooted(b, file, depth)
    return branch(node.whenTrue) && branch(node.whenFalse)
  }
  if (ts.isJsxSelfClosingElement(node)) {
    const tag = node.tagName.getText()
    return tag === 'SettingsPage' || delegatesToRootedPage(tag, file, depth)
  }
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText()
      if (tag === 'SettingsPage') return true
      if (/^[A-Z]/.test(tag)) return delegatesToRootedPage(tag, file, depth)
    }
    const children = node.children.filter(mentionsPage)
    return children.length > 0 && children.every((c) => rooted(c, file, depth))
  }
  if (ts.isJsxExpression(node))
    return node.expression ? rooted(node.expression, file, depth) : false
  return false
}

function entryIsRooted(name: string, file: string, depth = 0): boolean {
  const source = parse(file)
  let ok = false
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== name) continue
    const returns: ts.Expression[] = []
    const visit = (n: ts.Node): void => {
      if (n !== statement && ts.isFunctionLike(n)) return
      if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression)
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(statement, visit)
    ok = returns.length > 0 && returns.every((r) => isNull(r) || rooted(r, file, depth))
  }
  return ok
}

describe('settings pages', () => {
  const pages = renderedPages()

  it('finds the pages the panel renders', () => {
    expect(pages.length).toBeGreaterThan(25)
  })

  it('only drift from the page standard where the known offenders list says so', () => {
    const found: Record<string, Rule[]> = {}
    const note = (file: string, rule: Rule): void => {
      const key = file.slice(RENDERER.length + 1)
      found[key] = [...(found[key] ?? []), rule]
    }
    const checked = new Set<string>()
    for (const { name, file } of pages) {
      if (!entryIsRooted(name, file)) note(file, 'root')
      for (const member of closure(file)) {
        if (checked.has(member)) continue
        checked.add(member)
        const text = readFileSync(member, 'utf8')
        for (const rule of Object.keys(DRIFT) as (keyof typeof DRIFT)[]) {
          if (DRIFT[rule](text)) note(member, rule)
        }
      }
    }
    expect(found).toEqual(KNOWN_OFFENDERS)
  })
})
