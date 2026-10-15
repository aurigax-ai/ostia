import { existsSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { COMPOSER, STRINGS_DIR, repoPath } from './i18nCatalog.mjs'

const PROGRAM_CONFIGS = ['tsconfig.json', 'tsconfig.node.json']
const TEST_FILE = /\.(test|d)\.tsx?$/
const isCatalogueFile = (path) => path === COMPOSER || path.startsWith(`${STRINGS_DIR}/`)

function programFor(root, config) {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, config), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    },
  })
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
}

const declKey = (fileName, node) => `${fileName}:${node.pos}`

function propertyName(node) {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined
}

function collectCatalogue(program, root) {
  const nodes = new Map()
  const leaves = new Set()
  const walk = (fileName, literal, path) => {
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const name = propertyName(property)
      if (name === undefined) continue
      const at = path ? `${path}.${name}` : name
      nodes.set(declKey(fileName, property), at)
      if (ts.isObjectLiteralExpression(property.initializer)) walk(fileName, property.initializer, at)
      else if (!fileName.endsWith(COMPOSER)) leaves.add(at)
    }
  }
  for (const file of program.getSourceFiles()) {
    const path = repoPath(root, file.fileName)
    const area = path.startsWith(`${STRINGS_DIR}/`) && path.endsWith('En.ts')
    if (!area && path !== COMPOSER) continue
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const decl of statement.declarationList.declarations) {
        if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue
        if (area || (ts.isIdentifier(decl.name) && decl.name.text === 'en')) walk(file.fileName, decl.initializer, '')
      }
    }
  }
  return { nodes, leaves }
}

function isOpaqueType(checker, type, isCatalogue, depth = 0) {
  if (!type || depth > 4) return false
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive | ts.TypeFlags.TypeParameter)) return true
  if (type.isUnion() || type.isIntersection()) return type.types.some((t) => isOpaqueType(checker, t, isCatalogue, depth + 1))
  if (checker.getIndexInfosOfType(type).length > 0) return true
  const signature = type.getCallSignatures()[0]
  if (signature) return isOpaqueType(checker, checker.getReturnTypeOfSignature(signature), isCatalogue, depth + 1)
  return checker.getPropertiesOfType(type).some((p) => !(p.declarations ?? []).some(isCatalogue))
}

function continuesChain(node) {
  const parent = node.parent
  return (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  )
}

const isWrapper = (node) =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)

function escapesOpaquely(checker, node, isCatalogue) {
  let at = node
  while (isWrapper(at.parent)) {
    at = at.parent
    if ((ts.isAsExpression(at) || ts.isSatisfiesExpression(at)) && isOpaqueType(checker, checker.getTypeAtLocation(at.type), isCatalogue)) return true
  }
  if (continuesChain(at)) return false
  const parent = at.parent
  if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent) || ts.isJsxSpreadAttribute(parent)) return true
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return parent.expression === at
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword) return true
  return isOpaqueType(checker, checker.getContextualType(at), isCatalogue)
}

function literalKeys(checker, argument) {
  if (ts.isStringLiteralLike(argument)) return [argument.text]
  const type = checker.getTypeAtLocation(argument)
  const parts = type.isUnion() ? type.types : [type]
  if (parts.every((t) => t.isStringLiteral())) return parts.map((t) => t.value)
  return null
}

function markReferences(program, root, catalogue, used, whole) {
  const checker = program.getTypeChecker()
  const pathsOf = (symbols) => {
    const out = []
    for (const symbol of symbols) for (const decl of symbol?.declarations ?? []) {
      const path = catalogue.nodes.get(declKey(decl.getSourceFile().fileName, decl))
      if (path !== undefined) out.push(path)
    }
    return out
  }
  const isCatalogue = (decl) => catalogue.nodes.has(declKey(decl.getSourceFile().fileName, decl))
  const reach = (node, paths) => {
    if (paths.length === 0) return
    const opaque = !continuesChain(node) && escapesOpaquely(checker, node, isCatalogue)
    for (const path of paths) {
      used.add(path)
      if (opaque) whole.add(path)
    }
  }
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      reach(node, pathsOf([checker.getSymbolAtLocation(node.name)]))
    } else if (ts.isElementAccessExpression(node)) {
      const objectType = checker.getTypeAtLocation(node.expression)
      const keys = literalKeys(checker, node.argumentExpression)
      const members = keys
        ? keys.map((k) => checker.getPropertyOfType(objectType, k)).filter(Boolean)
        : checker.getPropertiesOfType(objectType)
      const paths = pathsOf(members)
      reach(node, paths)
      if (!keys) for (const path of paths) whole.add(path)
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken) {
      const name = node.propertyName ?? node.name
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        const type = checker.getTypeAtLocation(node.parent)
        for (const path of pathsOf([checker.getPropertyOfType(type, name.text)].filter(Boolean))) {
          used.add(path)
          whole.add(path)
        }
      }
    } else if (ts.isBindingElement(node) && node.dotDotDotToken) {
      const type = checker.getTypeAtLocation(node.parent)
      for (const path of pathsOf(checker.getPropertiesOfType(type))) whole.add(path)
    }
    ts.forEachChild(node, visit)
  }
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue
    const path = repoPath(root, file.fileName)
    if (!path.startsWith('src/') || TEST_FILE.test(path) || isCatalogueFile(path)) continue
    visit(file)
  }
}

export function unusedKeys(root) {
  const used = new Set()
  const whole = new Set()
  let leaves = new Set()
  for (const config of PROGRAM_CONFIGS.filter((name) => existsSync(join(root, name)))) {
    const program = programFor(root, config)
    const catalogue = collectCatalogue(program, root)
    leaves = new Set([...leaves, ...catalogue.leaves])
    markReferences(program, root, catalogue, used, whole)
  }
  const underWhole = (key) => {
    const parts = key.split('.')
    for (let i = 1; i <= parts.length; i++) if (whole.has(parts.slice(0, i).join('.'))) return true
    return false
  }
  return [...leaves].filter((key) => !used.has(key) && !underWhole(key)).sort()
}
