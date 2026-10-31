import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const USAGE = 'usage: node scripts/releaseNotes.mjs <tag>'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function previousTag(tag, cwd = process.cwd()) {
  const exclude = tag.includes('-') ? '*-main.*' : '*-*'
  try {
    return git(cwd, ['describe', '--tags', '--abbrev=0', '--exclude', exclude, `${tag}^`])
  } catch {
    return null
  }
}

export function releaseNotes(tag, cwd = process.cwd()) {
  const previous = previousTag(tag, cwd)
  const range = previous ? `${previous}..${tag}` : tag
  const log = git(cwd, ['log', '--no-merges', '--pretty=- %s (%h)', range])
  const lines = log.split('\n').filter((line) => line && !line.includes('chore(release)'))
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function main(args) {
  if (args.length !== 1) {
    console.error(USAGE)
    return 2
  }
  process.stdout.write(releaseNotes(args[0]))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
