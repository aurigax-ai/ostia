import { describe, expect, it } from 'vitest'
import { type SnapshotNode, formatSnapshot } from './browseSnapshot'

function node(role: string, name: string, extra: Partial<SnapshotNode> = {}): SnapshotNode {
  return { role, name, children: [], ...extra }
}

const page: SnapshotNode[] = [
  node('heading', 'Example Domain', { ref: 'e1', level: 1 }),
  node('navigation', '', {
    ref: 'e2',
    children: [
      node('list', '', {
        ref: 'e3',
        children: [
          node('listitem', '', {
            ref: 'e4',
            children: [
              node('link', 'Docs', { ref: 'e5', interactive: true, url: 'https://x.test/docs' }),
            ],
          }),
        ],
      }),
    ],
  }),
  node('paragraph', '', { ref: 'e6', children: [node('text', 'Hello there')] }),
  node('form', '', {
    ref: 'e7',
    children: [
      node('textbox', 'Email', { ref: 'e8', interactive: true, value: 'a@b.c' }),
      node('checkbox', 'Remember me', { ref: 'e9', interactive: true, checked: true }),
      node('button', 'Submit', { ref: 'e10', interactive: true, disabled: true }),
    ],
  }),
]

describe('formatSnapshot', () => {
  it('prints an indented aria tree with [ref=eN] tags and states', () => {
    const { snapshot } = formatSnapshot(page)
    expect(snapshot.split('\n')).toEqual([
      '- heading "Example Domain" [ref=e1] [level=1]',
      '- navigation [ref=e2]',
      '  - list [ref=e3]',
      '    - listitem [ref=e4]',
      '      - link "Docs" [ref=e5]',
      '- paragraph [ref=e6]',
      '  - text: Hello there',
      '- form [ref=e7]',
      '  - textbox "Email" [ref=e8]: a@b.c',
      '  - checkbox "Remember me" [ref=e9] [checked]',
      '  - button "Submit" [ref=e10] [disabled]',
    ])
  })

  it('returns a ref map with role and name for every printed ref', () => {
    const { refs } = formatSnapshot(page)
    expect(refs.e1).toEqual({ role: 'heading', name: 'Example Domain' })
    expect(refs.e10).toEqual({ role: 'button', name: 'Submit' })
    expect(Object.keys(refs)).toHaveLength(10)
  })

  it('keeps only interactive elements with -i, lifting them out of their containers', () => {
    const { snapshot, refs } = formatSnapshot(page, { interactive: true })
    expect(snapshot.split('\n')).toEqual([
      '- link "Docs" [ref=e5]',
      '- textbox "Email" [ref=e8]: a@b.c',
      '- checkbox "Remember me" [ref=e9] [checked]',
      '- button "Submit" [ref=e10] [disabled]',
    ])
    expect(Object.keys(refs)).toEqual(['e5', 'e8', 'e9', 'e10'])
  })

  it('collapses unnamed single-child wrappers with -c', () => {
    const { snapshot } = formatSnapshot(page, { compact: true })
    expect(snapshot).toContain('- link "Docs" [ref=e5]')
    expect(snapshot).not.toContain('listitem')
    expect(snapshot).not.toContain('- list ')
    expect(snapshot).toContain('- text: Hello there')
  })

  it('drops empty structural nodes with -c', () => {
    const { snapshot } = formatSnapshot([node('group', '', { ref: 'e1' }), node('main', 'Body')], {
      compact: true,
    })
    expect(snapshot).toBe('- main "Body"')
  })

  it('stops at the requested depth with -d', () => {
    const { snapshot, refs } = formatSnapshot(page, { depth: 1 })
    expect(snapshot.split('\n')).toEqual([
      '- heading "Example Domain" [ref=e1] [level=1]',
      '- navigation [ref=e2]',
      '- paragraph [ref=e6]',
      '- form [ref=e7]',
    ])
    expect(refs.e5).toBeUndefined()
  })

  it('adds link urls with -u', () => {
    const { snapshot } = formatSnapshot(page, { interactive: true, urls: true })
    expect(snapshot.split('\n').slice(0, 2)).toEqual([
      '- link "Docs" [ref=e5]',
      '  - /url: https://x.test/docs',
    ])
  })

  it('quotes names as JSON strings so embedded quotes stay unambiguous', () => {
    const { snapshot } = formatSnapshot([node('button', 'Say "hi"', { ref: 'e1' })])
    expect(snapshot).toBe('- button "Say \\"hi\\"" [ref=e1]')
  })
})
