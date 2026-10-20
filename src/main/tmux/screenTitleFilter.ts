const ESC = '\x1b'
const CAN = '\x18'
const SUB = '\x1a'
const MAX_TITLE = 8192

const Ground = 0
const Escape = 1
const Title = 2
const TitleEscape = 3

export class ScreenTitleFilter {
  private state = Ground as number
  private title = 0

  push(data: string): string {
    let out = ''
    for (const ch of data) {
      switch (this.state) {
        case Ground:
          if (ch === ESC) this.state = Escape
          else out += ch
          break
        case Escape:
          if (ch === 'k') {
            this.state = Title
            this.title = 0
          } else if (ch === ESC) {
            out += ESC
          } else {
            out += ESC + ch
            this.state = Ground
          }
          break
        case Title:
          if (ch === CAN || ch === SUB) this.state = Ground
          else if (ch === ESC) this.state = TitleEscape
          else if (++this.title > MAX_TITLE) this.state = Ground
          break
        case TitleEscape:
          if (ch === '\\') this.state = Ground
          else if (ch === CAN || ch === SUB) this.state = Ground
          else if (ch === ESC) this.state = TitleEscape
          else this.state = Title
          break
      }
    }
    return out
  }
}
