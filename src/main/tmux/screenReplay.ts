export const SCREEN_INFO_FORMAT = [
  '#{alternate_on}',
  '#{cursor_x}',
  '#{cursor_y}',
  '#{cursor_flag}',
  '#{keypad_cursor_flag}',
  '#{keypad_flag}',
  '#{mouse_standard_flag}',
  '#{mouse_button_flag}',
  '#{mouse_any_flag}',
  '#{mouse_sgr_flag}',
  '#{bracket_paste_flag}',
].join(' ')

const RESET = '\x1b[0m'
const MODES: [index: number, set: string][] = [
  [4, '\x1b[?1h'],
  [5, '\x1b='],
  [6, '\x1b[?1000h'],
  [7, '\x1b[?1002h'],
  [8, '\x1b[?1003h'],
  [9, '\x1b[?1006h'],
  [10, '\x1b[?2004h'],
]

function lines(rows: readonly string[]): string {
  return rows.map((row) => `${row}${RESET}`).join('\r\n')
}

export function screenReplay(
  info: string,
  normal: readonly string[],
  alternate: readonly string[] | null,
): string {
  const fields = info.trim().split(' ')
  const x = Number(fields[1]) || 0
  const y = Number(fields[2]) || 0
  let out = lines(normal)
  if (alternate) out += `\x1b[?1049h\x1b[H\x1b[2J${lines(alternate)}`
  out += `\x1b[${y + 1};${x + 1}H`
  if (fields[3] === '0') out += '\x1b[?25l'
  for (const [index, set] of MODES) if (fields[index] === '1') out += set
  return out
}
