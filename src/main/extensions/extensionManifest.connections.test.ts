import { describe, expect, it } from 'vitest'
import { localizeManifest, manifestSlots } from './extensionLocales'
import { parseManifest } from './extensionManifest'

const DIR = '/ext/demo'

const HTTP = {
  kind: 'http',
  title: 'HTTP API',
  description: 'An API you call over HTTP',
  fields: {
    baseUrl: { title: 'Base URL', type: 'string', required: true },
    auth: { title: 'Auth', type: 'enum', enum: ['none', 'bearer'], default: 'bearer' },
  },
  secrets: { secret: { title: 'Token', description: 'Sent as the bearer token' } },
}

function withConnections(connections: unknown) {
  return parseManifest(
    {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      api: '4.0',
      main: 'main.js',
      contributes: { connections },
    },
    DIR,
  )
}

describe('contributes.connections', () => {
  it('parses connection kinds with their fields and secrets', () => {
    const res = withConnections([HTTP])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.manifest.contributes.connections).toEqual([
      {
        kind: 'http',
        title: 'HTTP API',
        description: 'An API you call over HTTP',
        fields: [
          { key: 'baseUrl', title: 'Base URL', type: 'string', required: true },
          { key: 'auth', title: 'Auth', type: 'enum', enum: ['none', 'bearer'], default: 'bearer' },
        ],
        secrets: [{ key: 'secret', title: 'Token', description: 'Sent as the bearer token' }],
      },
    ])
    const none = parseManifest({ id: 'demo', name: 'Demo', version: '1.0.0', api: '4.0' }, DIR)
    expect(none.ok && none.manifest.contributes.connections).toBeUndefined()
  })

  it.each([
    ['an empty list', [], 'contributes.connections must be an array of 1-8 kinds'],
    [
      'nine kinds',
      Array.from({ length: 9 }, (_, i) => ({ ...HTTP, kind: `k${i}` })),
      'array of 1-8',
    ],
    ['a bad kind', [{ ...HTTP, kind: 'Bad' }], 'contributes.connections[0]: invalid kind'],
    ['a kind twice', [HTTP, HTTP], 'kind http is declared twice'],
    ['no title', [{ ...HTTP, title: '' }], 'contributes.connections[0]: title must be'],
    ['no fields', [{ ...HTTP, fields: undefined }], 'fields must be an object'],
    [
      'nine fields',
      [
        {
          ...HTTP,
          fields: Object.fromEntries(
            Array.from({ length: 9 }, (_, i) => [`f${i}`, { title: 'F', type: 'string' }]),
          ),
        },
      ],
      'more than 8 fields',
    ],
    [
      'a bad field key',
      [{ ...HTTP, fields: { 'bad key': { title: 'F', type: 'string' } } }],
      'fields.bad key: invalid key',
    ],
    [
      'a bad field type',
      [{ ...HTTP, fields: { n: { title: 'N', type: 'number' } } }],
      'fields.n: type must be one of string, enum',
    ],
    [
      'an enum without values',
      [{ ...HTTP, fields: { a: { title: 'A', type: 'enum' } } }],
      'fields.a: enum must be',
    ],
    [
      'enum on a string',
      [{ ...HTTP, fields: { a: { title: 'A', type: 'string', enum: ['x'] } } }],
      'enum is for enum fields',
    ],
    [
      'a default not in the enum',
      [{ ...HTTP, fields: { a: { title: 'A', type: 'enum', enum: ['x'], default: 'y' } } }],
      'default is not in enum',
    ],
    [
      'a non-boolean required',
      [{ ...HTTP, fields: { a: { title: 'A', type: 'string', required: 'yes' } } }],
      'required must be a boolean',
    ],
    [
      'five secrets',
      [
        {
          ...HTTP,
          secrets: Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`s${i}`, { title: 'S' }]),
          ),
        },
      ],
      'more than 4 secrets',
    ],
    [
      'a secret that is also a field',
      [{ ...HTTP, secrets: { baseUrl: { title: 'B' } } }],
      'secrets.baseUrl: also a field',
    ],
    [
      'a secret without a title',
      [{ ...HTTP, secrets: { secret: {} } }],
      'secrets.secret: title must be',
    ],
  ])('refuses %s', (_name, connections, error) => {
    const res = withConnections(connections)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain(error)
  })

  it('lets connections alone give an extension a settings page', () => {
    const res = parseManifest(
      {
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        api: '4.0',
        main: 'main.js',
        contributes: { connections: [HTTP], settingsPage: { title: 'Demo' } },
      },
      DIR,
    )
    expect(res.ok).toBe(true)
  })

  it('translates a kind, its fields and its secrets through the locale catalog', () => {
    const res = withConnections([HTTP])
    if (!res.ok) throw new Error(res.error)
    const slots = manifestSlots(res.manifest)
    for (const key of [
      'connections.http.title',
      'connections.http.description',
      'connections.http.fields.baseUrl.title',
      'connections.http.secrets.secret.title',
      'connections.http.secrets.secret.description',
    ])
      expect(slots.has(key)).toBe(true)
    const localized = localizeManifest(res.manifest, {
      'connections.http.title': 'HTTP 介面',
      'connections.http.fields.baseUrl.title': '網址',
      'connections.http.secrets.secret.title': '權杖',
    })
    const kind = localized.contributes.connections?.[0]
    expect(kind?.title).toBe('HTTP 介面')
    expect(kind?.fields[0]?.title).toBe('網址')
    expect(kind?.fields[1]?.title).toBe('Auth')
    expect(kind?.secrets[0]?.title).toBe('權杖')
  })
})
