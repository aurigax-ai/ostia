import { createHash } from 'node:crypto'
import { NODE_ENTRY, NODE_HOME, NODE_STATUS_PREFIX } from '../../../shared/remote/remoteNode'
import { posixCksum } from '../helper'

export interface BundleFile {
  name: string
  data: Buffer
}

export interface NodeBundle {
  version: string
  data: Buffer
  install: string
  dir: string
  run: (command: string) => string
}

const PATH_EXTRA = '$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin'

export function remoteWord(script: string): string {
  return `exec sh -c 'PATH="$PATH:${PATH_EXTRA}"; ${script}'`
}

function say(json: string): string {
  return `{ echo "${NODE_STATUS_PREFIX}${json.replaceAll('"', '\\"')}"; exit 0; }`
}

function checksum(data: Buffer): string {
  return `${posixCksum(data)} ${data.length}`
}

function lines(data: Buffer): number {
  if (data.length === 0 || data[data.length - 1] !== 0x0a) {
    throw new Error(`${data.length} bytes do not end with a newline`)
  }
  return data.toString('latin1').split('\n').length - 1
}

export function nodeBundle(files: readonly BundleFile[]): NodeBundle {
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.name).update('\0').update(file.data).update('\0')
  const version = hash.digest('hex').slice(0, 12)
  const dir = `$HOME/${NODE_HOME}/${version}`
  let from = 1
  const slices = files.map((file) => {
    const count = lines(file.data)
    const first = from
    from += count
    return [
      `tail -n +${first} "$d/bundle.new" | head -n ${count} >"$d/${file.name}.new"`,
      `[ "$(cksum <"$d/${file.name}.new")" = "${checksum(file.data)}" ] || { rm -rf "$d"; ${say('{"ok":false,"error":"failed checksum"}')}; }`,
      `mv -f "$d/${file.name}.new" "$d/${file.name}"`,
    ]
  })
  const install = remoteWord(
    [
      'umask 077',
      `d="${dir}"`,
      `mkdir -p "$d" || ${say('{"ok":false,"error":"failed mkdir"}')}`,
      `cat >"$d/bundle.new" || ${say('{"ok":false,"error":"failed write"}')}`,
      ...slices.flat(),
      'rm -f "$d/bundle.new"',
      `echo "${NODE_STATUS_PREFIX}{\\"version\\":\\"${version}\\"}"`,
    ].join('; '),
  )
  const entry = files.find((file) => file.name === NODE_ENTRY)
  if (!entry) throw new Error(`${NODE_ENTRY} is missing from the bundle`)
  return {
    version,
    data: Buffer.concat(files.map((file) => file.data)),
    install,
    dir,
    run: (command) =>
      remoteWord(
        [
          `f="${dir}/${NODE_ENTRY}"`,
          `[ -f "$f" ] || ${say('{"ok":false,"error":"missing"}')}`,
          `[ "$(cksum <"$f")" = "${checksum(entry.data)}" ] || ${say('{"ok":false,"error":"corrupt"}')}`,
          `exec node "$f" ${command}`,
        ].join('; '),
      ),
  }
}
