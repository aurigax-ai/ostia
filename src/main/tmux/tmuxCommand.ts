const SEND_KEYS_CHUNK = 512
const WITHOUT_TMUX_ENV = ['/usr/bin/env', '-u', 'TMUX', '-u', 'TMUX_PANE']

export function tmuxQuote(arg: string): string {
  let out = '"'
  for (const ch of arg) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\\' || ch === '"' || ch === '$') out += `\\${ch}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`
    else out += ch
  }
  return `${out}"`
}

export function tmuxFormatQuote(arg: string): string {
  return tmuxQuote(arg.replaceAll('#', '##'))
}

export function sendKeysCommands(target: string, data: string): string[] {
  const bytes = Buffer.from(data, 'utf8')
  const commands: string[] = []
  for (let i = 0; i < bytes.length; i += SEND_KEYS_CHUNK) {
    const hex = [...bytes.subarray(i, i + SEND_KEYS_CHUNK)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    commands.push(`send-keys -t ${target} -H ${hex}`)
  }
  return commands
}

export interface NewWindowSpec {
  session: string
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export function newWindowCommand(spec: NewWindowSpec): string {
  const env = Object.entries(spec.env)
    .filter(([key]) => key !== '' && !key.includes('='))
    .map(([key, value]) => `-e ${tmuxQuote(`${key}=${value}`)}`)
  return [
    'new-window -d -P -F "#{window_id} #{pane_id} #{pane_pid}"',
    `-t ${tmuxQuote(`${spec.session}:`)}`,
    `-c ${tmuxFormatQuote(spec.cwd)}`,
    ...env,
    '--',
    ...[...WITHOUT_TMUX_ENV, spec.file, ...spec.args].map(tmuxQuote),
  ].join(' ')
}
