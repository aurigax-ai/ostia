import { describe, expect, it } from 'vitest'
import { viewJsonSchema } from './viewSchema'
import {
  VIEW_MAX_DEPTH,
  VIEW_MAX_LIST_ITEMS,
  VIEW_MAX_NODES,
  VIEW_NODE_TYPES,
  type ViewDoc,
  formatViewProblem,
  parseViewText,
  viewNameOf,
} from './views'

function doc(root: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, title: 'Agents', placement: 'sidebar', root, ...extra })
}

function ok(text: string): ViewDoc {
  const res = parseViewText(text)
  if (!res.ok) throw new Error(JSON.stringify(res.problems))
  return res.doc
}

function problems(text: string): string[] {
  const res = parseViewText(text)
  if (res.ok) throw new Error('expected problems')
  return res.problems.map((p) => `${p.path}: ${p.message}`)
}

const GOOD = `{
  "version": 1,
  "title": "Workspaces",
  "placement": "sidebar",
  "icon": "robot",
  "root": {
    "type": "stack",
    "children": [
      { "type": "text", "text": "{{clock.now | time}}", "tone": "muted", "size": "xs" },
      {
        "type": "list",
        "for": "workspaces",
        "as": "ws",
        "limit": 10,
        "empty": "No workspaces",
        "item": {
          "type": "row",
          "justify": "between",
          "children": [
            { "type": "text", "text": "{{ws.name}}", "truncate": true },
            { "type": "badge", "text": "{{ws.unread}}", "tone": "warn", "if": "{{ws.unread}}" },
            {
              "type": "button",
              "label": "Open",
              "icon": "arrow-right",
              "variant": "ghost",
              "action": { "command": "workspace.goto", "args": { "index": "{{ws.index}}" } }
            }
          ]
        }
      },
      { "type": "progress", "value": "{{approvals.pending}}", "max": 5, "label": "Approvals" },
      { "type": "kv", "items": [{ "key": "Ports", "value": "{{ports | count}}" }] },
      { "type": "link", "label": "Docs", "url": "https://example.com/docs" },
      { "type": "divider" },
      { "type": "icon", "name": "check", "tone": "ok", "label": "fine" },
      { "type": "section", "title": "More", "collapsed": true, "children": [] }
    ]
  }
}`

describe('parseViewText', () => {
  it('accepts a view that uses every component', () => {
    const view = ok(GOOD)
    expect(view.placement).toBe('sidebar')
    expect(view.icon).toBe('robot')
    expect(view.sources).toEqual(['workspaces', 'ports', 'approvals', 'clock'])
    expect(view.ticks).toBe(true)
  })

  it('reports the line of a bad property', () => {
    const res = parseViewText(GOOD.replace('"tone": "warn"', '"tone": "loud"'))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.problems).toHaveLength(1)
    expect(res.problems[0].path).toBe('root.children[1].item.children[1].tone')
    expect(res.problems[0].line).toBe(GOOD.split('\n').findIndex((l) => l.includes('"warn"')) + 1)
    expect(formatViewProblem('agents.json', res.problems[0])).toMatch(
      /^agents\.json:\d+: root\.children\[1\]\.item\.children\[1\]\.tone: must be one of/,
    )
  })

  it('reports JSON syntax errors with line and column', () => {
    const res = parseViewText('{\n  "version": 1,\n  "title": }')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.problems[0].line).toBe(3)
    expect(res.problems[0].message).toMatch(/invalid JSON at column 12/)
  })

  it('rejects unknown properties, node types and duplicate keys', () => {
    expect(problems(doc({ type: 'text', text: 'hi', onClick: 'x' }))).toEqual([
      expect.stringMatching(/^root\.onClick: unknown property 'onClick'/),
    ])
    expect(problems(doc({ type: 'html', html: '<b>' }))[0]).toMatch(/^root\.type: must be one of/)
    expect(problems('{"version":1,"version":1}')[0]).toMatch(/duplicate property 'version'/)
    expect(problems(doc({ type: 'divider' }, { script: 'alert(1)' }))[0]).toMatch(
      /^script: unknown property/,
    )
  })

  it('requires version, title, placement and root', () => {
    expect(problems('{}')).toEqual([
      'version: must be 1',
      'title: is required',
      'placement: is required (sidebar or panel)',
      'root: is required',
    ])
  })

  it('rejects unknown data sources, filters and prototype paths', () => {
    expect(problems(doc({ type: 'text', text: '{{process.env}}' }))[0]).toMatch(
      /unknown data source 'process'/,
    )
    expect(problems(doc({ type: 'text', text: '{{workspace.name | eval}}' }))[0]).toMatch(
      /unknown filter 'eval'/,
    )
    expect(problems(doc({ type: 'text', text: '{{workspace.__proto__}}' }))[0]).toMatch(
      /'__proto__' is not allowed/,
    )
    expect(problems(doc({ type: 'text', text: '{{workspace.constructor.name}}' }))[0]).toMatch(
      /'constructor' is not allowed/,
    )
    expect(problems(doc({ type: 'text', text: '{{workspace["x"]}}' }))[0]).toMatch(
      /not a property path/,
    )
    expect(problems(doc({ type: 'text', text: '{{ workspace.name' }))[0]).toMatch(/unbalanced/)
  })

  it('scopes a list variable to its item', () => {
    const list = {
      type: 'list',
      for: 'panes',
      as: 'p',
      item: { type: 'text', text: '{{p.title}}' },
    }
    expect(ok(doc(list)).sources).toEqual(['panes'])
    expect(
      problems(doc({ type: 'stack', children: [list, { type: 'text', text: '{{p.title}}' }] }))[0],
    ).toMatch(/^root\.children\[1\]\.text: unknown data source 'p'/)
    expect(problems(doc({ ...list, as: 'workspace' }))[0]).toMatch(/already a data source/)
  })

  it('allows only http and https URLs', () => {
    const link = (url: string) => doc({ type: 'link', label: 'x', url })
    expect(ok(link('https://example.com')).root.type).toBe('link')
    expect(ok(link('{{workspace.name}}')).root.type).toBe('link')
    expect(ok(link('http://localhost:{{workspace.name}}/')).root.type).toBe('link')
    expect(problems(link('javascript:alert(1)'))[0]).toMatch(/http:\/\/ or https:\/\//)
    expect(problems(link('file:///etc/passwd'))[0]).toMatch(/http:\/\/ or https:\/\//)
    expect(problems(link('javascript:{{workspace.name}}'))[0]).toMatch(/must start with/)
    const button = (openUrl: string) => doc({ type: 'button', label: 'x', action: { openUrl } })
    expect(problems(button('data:text/html,hi'))[0]).toMatch(/^root\.action\.openUrl:/)
  })

  it('checks button actions', () => {
    const button = (action: unknown) => doc({ type: 'button', label: 'Go', action })
    expect(ok(button({ command: 'workspace.new', args: { name: 'x' } })).root.type).toBe('button')
    expect(problems(button({ command: 'rm -rf /' }))[0]).toMatch(/palette command id/)
    expect(problems(button({ command: 'a', run: 'x' }))[0]).toMatch(/unknown property 'run'/)
    expect(problems(button({ command: 'a', args: { big: 'x'.repeat(5000) } }))[0]).toMatch(
      /larger than/,
    )
    expect(problems(button({ command: 'a', args: { id: '{{nope}}' } }))[0]).toMatch(
      /^root\.action\.args\.id: unknown data source/,
    )
  })

  it('enforces the node and depth budget', () => {
    const many = {
      type: 'stack',
      children: Array.from({ length: VIEW_MAX_NODES }, () => ({ type: 'divider' })),
    }
    expect(problems(doc(many))).toEqual([
      expect.stringMatching(new RegExp(`more than ${VIEW_MAX_NODES} nodes`)),
    ])
    let deep: unknown = { type: 'divider' }
    for (let i = 0; i < VIEW_MAX_DEPTH; i++) deep = { type: 'stack', children: [deep] }
    expect(problems(doc(deep))[0]).toMatch(new RegExp(`deeper than ${VIEW_MAX_DEPTH}`))
    const list = {
      type: 'list',
      for: 'workspaces',
      limit: VIEW_MAX_LIST_ITEMS + 1,
      item: { type: 'divider' },
    }
    expect(problems(doc(list))[0]).toMatch(/^root\.limit: must be a whole number/)
  })

  it('requires single bindings for if and progress values', () => {
    expect(problems(doc({ type: 'divider', if: 'yes {{workspace}}' }))[0]).toMatch(
      /single \{\{binding\}\}/,
    )
    expect(problems(doc({ type: 'progress', value: 'half' }))[0]).toMatch(/single \{\{binding\}\}/)
  })
})

describe('viewNameOf', () => {
  it('takes lowercase names from .json files only', () => {
    expect(viewNameOf('agents.json')).toBe('agents')
    expect(viewNameOf('my-view-2.json')).toBe('my-view-2')
    expect(viewNameOf('Agents.json')).toBeNull()
    expect(viewNameOf('agents.js')).toBeNull()
    expect(viewNameOf('.json')).toBeNull()
  })
})

describe('viewJsonSchema', () => {
  it('describes every node type the validator accepts', () => {
    const schema = viewJsonSchema() as {
      $defs: { node: { oneOf: { properties: { type: { const: string } } }[] } }
    }
    const types = schema.$defs.node.oneOf.map((n) => n.properties.type.const)
    expect(types.sort()).toEqual([...VIEW_NODE_TYPES].sort())
  })
})
