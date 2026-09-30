export interface LineEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  text: string
}

export function minimalLineEdit(current: string, next: string): LineEdit | null {
  if (current === next) return null
  const a = current.split('\n')
  const b = next.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }
  const oldEnd = a.length - tail
  const newLines = b.slice(head, b.length - tail)
  if (oldEnd > head && newLines.length === 0) {
    if (oldEnd < a.length) {
      return {
        range: {
          startLineNumber: head + 1,
          startColumn: 1,
          endLineNumber: oldEnd + 1,
          endColumn: 1,
        },
        text: '',
      }
    }
    if (head > 0) {
      return {
        range: {
          startLineNumber: head,
          startColumn: (a[head - 1] ?? '').length + 1,
          endLineNumber: oldEnd,
          endColumn: (a[oldEnd - 1] ?? '').length + 1,
        },
        text: '',
      }
    }
  }
  if (oldEnd > head) {
    const lastOld = a[oldEnd - 1] ?? ''
    return {
      range: {
        startLineNumber: head + 1,
        startColumn: 1,
        endLineNumber: oldEnd,
        endColumn: lastOld.length + 1,
      },
      text: newLines.join('\n'),
    }
  }
  const atEnd = head >= a.length
  return atEnd
    ? {
        range: {
          startLineNumber: a.length,
          startColumn: (a[a.length - 1] ?? '').length + 1,
          endLineNumber: a.length,
          endColumn: (a[a.length - 1] ?? '').length + 1,
        },
        text: `\n${newLines.join('\n')}`,
      }
    : {
        range: { startLineNumber: head + 1, startColumn: 1, endLineNumber: head + 1, endColumn: 1 },
        text: `${newLines.join('\n')}\n`,
      }
}
