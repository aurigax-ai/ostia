import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  GRAPHS_LISTED_MAX,
  type LoadedGraph,
  NAME_PATTERN,
  type Problem,
  readGraphFile,
} from '@aurigax-ai/graph'
import { PRODUCT_NAME } from '../sdk'

const GRAPHS_FOLDER = join(`.${PRODUCT_NAME.toLowerCase()}`, 'graphs')

export interface GraphEntry {
  name: string
  path: string
  realPath: string
  loaded: LoadedGraph | null
  problems: Problem[]
}

export function graphsFolder(workDir: string): string {
  return join(workDir, GRAPHS_FOLDER)
}

function realOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function graphPath(workDir: string, name: string): string | null {
  return NAME_PATTERN.test(name) ? join(graphsFolder(workDir), `${name}.yaml`) : null
}

export function readGraph(workDir: string, path: string): GraphEntry {
  const loaded = readGraphFile(path, workDir)
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '')
  return {
    name,
    path,
    realPath: realOf(path),
    loaded: loaded.ok ? loaded.value : null,
    problems: loaded.ok ? [] : loaded.problems,
  }
}

export function listGraphs(workDir: string): GraphEntry[] {
  let names: string[]
  try {
    names = readdirSync(graphsFolder(workDir))
      .filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
      .sort()
  } catch {
    return []
  }
  return names.map((file, i) => {
    const path = join(graphsFolder(workDir), file)
    if (i < GRAPHS_LISTED_MAX) return readGraph(workDir, path)
    return {
      name: file.replace(/\.ya?ml$/, ''),
      path,
      realPath: realOf(path),
      loaded: null,
      problems: [
        {
          code: 'over-limit',
          message: `only ${GRAPHS_LISTED_MAX} graphs are listed per workspace`,
        },
      ],
    }
  })
}
