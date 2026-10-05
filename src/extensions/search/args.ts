import type { TextQuery } from './rg'

export const FILES_LIMIT_DEFAULT = 20
export const FILES_LIMIT_MAX = 200

export interface FindArgs {
  query: TextQuery
  json: boolean
}

export interface FilesArgs {
  query: string
  limit: number
  json: boolean
}

export function parseFindArgs(argv: string[]): FindArgs | string {
  const query: TextQuery = {
    text: '',
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    include: [],
    exclude: [],
  }
  let json = false
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      words.push(...argv.slice(i + 1))
      break
    }
    if (arg === '--regex' || arg === '-e') query.regex = true
    else if (arg === '--case-sensitive' || arg === '-s') query.caseSensitive = true
    else if (arg === '--word' || arg === '-w') query.wholeWord = true
    else if (arg === '--json') json = true
    else if (arg === '--glob' || arg === '-g') {
      const glob = argv[++i]
      if (!glob) return '--glob needs a pattern'
      if (glob.startsWith('!')) query.exclude.push(glob.slice(1))
      else query.include.push(glob)
    } else if (arg.startsWith('-') && arg.length > 1) return `unknown option ${arg}`
    else words.push(arg)
  }
  query.text = words.join(' ')
  if (!query.text) return 'name the text to find'
  return { query, json }
}

export function parseFilesArgs(argv: string[]): FilesArgs | string {
  let limit = FILES_LIMIT_DEFAULT
  let json = false
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1 || n > FILES_LIMIT_MAX) {
        return `--limit takes a number from 1 to ${FILES_LIMIT_MAX}`
      }
      limit = n
    } else if (arg.startsWith('--')) return `unknown option ${arg}`
    else words.push(arg)
  }
  const query = words.join('')
  if (!query) return 'name part of the file name to find'
  return { query, limit, json }
}
