const ESC = '\x1b'
const CAN = '\x18'
const SUB = '\x1a'
const DEL = '\x7f'

const Ground = 0
const Escape = 1
const Title = 2
const TitleEscape = 3

function isC0(ch: string): boolean {
  return ch < ' ' && ch !== ESC && ch !== CAN && ch !== SUB
}

export class ScreenTitleFilter {
  private state = Ground as number
  private ignored = ''

  push(data: string): string {
    if (this.state === Ground && !data.includes(ESC)) return data
    let out = ''
    for (const ch of data) {
      switch (this.state) {
        case Ground:
          if (ch === ESC) this.state = Escape
          else out += ch
          break
        case Escape:
        case TitleEscape:
          if (ch >= DEL) this.ignored += ch
          else if (ch === 'k') {
            this.ignored = ''
            this.state = Title
          } else if (ch === '\\' && this.state === TitleEscape) {
            this.ignored = ''
            this.state = Ground
          } else if (ch === ESC) this.ignored = ''
          else if (isC0(ch)) out += ch
          else {
            out += ESC + this.ignored + ch
            this.ignored = ''
            this.state = Ground
          }
          break
        case Title:
          if (ch === ESC) this.state = TitleEscape
          else if (ch === CAN || ch === SUB) this.state = Ground
          break
      }
    }
    return out
  }
}
