import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const root = join(import.meta.dirname, '..')
const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { catalog } = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))

export function dependencyRange(name) {
  const range = app.dependencies[name] ?? app.devDependencies[name]
  return range === 'catalog:' ? catalog[name] : range
}
