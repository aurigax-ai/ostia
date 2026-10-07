import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const ROOT = join(import.meta.dirname, '..')

const ROOT_DOC = /^[^/]+\.md$/
const READS_FILES = /from 'node:fs(\/promises)?'/

function runsEverything(file) {
  return !file.startsWith('src/') && !file.startsWith('e2e/') && !ROOT_DOC.test(file)
}

function staysInRenderer(file) {
  return (
    !file.startsWith('src/') ||
    (file.startsWith('src/renderer/') && !file.startsWith('src/renderer/i18n/'))
  )
}

export function planTests(changed, domFileReaders) {
  if (changed.some(runsEverything)) return { node: null, dom: null }
  const sources = changed.filter((file) => file.startsWith('src/'))
  return {
    node: sources.every(staysInRenderer) ? sources : null,
    dom: [...new Set([...sources, ...domFileReaders])],
  }
}

export function domFileReaders(root = ROOT) {
  return readdirSync(join(root, 'src/renderer'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => `src/renderer/${file}`)
    .filter((file) => READS_FILES.test(readFileSync(join(root, file), 'utf8')))
    .sort()
}

export function vitestArgs(project, files) {
  if (files === null) return ['run', '--project', project]
  return ['related', '--run', '--project', project, '--passWithNoTests', ...files]
}
