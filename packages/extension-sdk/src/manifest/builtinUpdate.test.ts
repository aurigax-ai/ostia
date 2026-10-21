import { describe, expect, it } from 'vitest'
import type { ExtensionManifest } from '../contract/extensions'
import { builtinUpdateProblem } from './builtinUpdate'

interface Override extends Omit<Partial<ExtensionManifest>, 'contributes'> {
  contributes?: Partial<ExtensionManifest['contributes']>
}

function manifest(over: Override = {}): ExtensionManifest {
  const { contributes, ...rest } = over
  return {
    id: 'csv',
    name: 'CSV',
    version: '1.0.0',
    api: '7.0',
    description: '',
    category: 'other',
    capabilities: ['file-contents'],
    main: 'main.js',
    ...rest,
    contributes: {
      commands: [],
      sidebarItems: false,
      paneChips: [],
      workspaceChips: [],
      settings: [],
      assist: [],
      secrets: [],
      fileKinds: [
        {
          id: 'csv.table',
          displayName: 'Table',
          selector: [{ filenamePattern: '*.csv' }, { filenamePattern: '*.tsv' }],
          view: { entry: 'view.html', priority: 'default' },
        },
      ],
      ...contributes,
    },
  } as ExtensionManifest
}

describe('builtinUpdateProblem', () => {
  const bundled = manifest()

  it('accepts a copy that claims no more than the bundled one', () => {
    expect(builtinUpdateProblem(bundled, manifest({ version: '1.1.0' }))).toBeNull()
    expect(
      builtinUpdateProblem(
        bundled,
        manifest({
          contributes: {
            fileKinds: [
              {
                id: 'csv.table',
                displayName: 'Table',
                selector: [{ filenamePattern: '*.csv' }],
                view: { entry: 'view.html', priority: 'option' },
              },
            ],
          },
        }),
      ),
    ).toBeNull()
  })

  it('refuses a raised capability', () => {
    expect(
      builtinUpdateProblem(bundled, manifest({ capabilities: ['file-contents', 'notify'] })),
    ).toBe('asks for notify, which the bundled one does not')
  })

  it('refuses a new file kind, pattern, role or a higher viewer priority', () => {
    const kind = (extra: object): Override => ({
      contributes: {
        fileKinds: [
          {
            id: 'csv.table',
            displayName: 'Table',
            selector: [{ filenamePattern: '*.csv' }],
            view: { entry: 'view.html', priority: 'default' },
            ...extra,
          },
        ],
      },
    })
    expect(
      builtinUpdateProblem(
        bundled,
        manifest({
          contributes: {
            fileKinds: [{ id: 'csv.other', displayName: 'O', selector: [], browse: {} }],
          },
        }),
      ),
    ).toBe('file kind csv.other is new')
    expect(
      builtinUpdateProblem(bundled, manifest(kind({ selector: [{ filenamePattern: '*.log' }] }))),
    ).toContain('claims *.log')
    expect(builtinUpdateProblem(bundled, manifest(kind({ browse: {} })))).toBe(
      'file kind csv.table gains the browse role',
    )
    const option = manifest({
      contributes: {
        fileKinds: [
          {
            id: 'csv.table',
            displayName: 'Table',
            selector: [{ filenamePattern: '*.csv' }],
            view: { entry: 'view.html', priority: 'option' },
          },
        ],
      },
    })
    expect(
      builtinUpdateProblem(option, manifest(kind({ selector: [{ filenamePattern: '*.csv' }] }))),
    ).toBe('file kind csv.table raises its viewer priority')
  })

  it('refuses what gates a built-in-only host method and a program the bundled one lacks', () => {
    const none = manifest({ main: undefined })
    expect(builtinUpdateProblem(none, manifest())).toBe('starts a program')
    expect(
      builtinUpdateProblem(
        bundled,
        manifest({
          contributes: {
            commands: [
              {
                id: 'go',
                title: 'Go',
                palette: true,
                stdin: false,
                needsPlaybook: true,
                capabilities: [],
              },
            ],
          },
        }),
      ),
    ).toBe('command go gains needsPlaybook')
    expect(
      builtinUpdateProblem(
        bundled,
        manifest({
          contributes: { agentSkills: [{ name: 'remember', path: 's', files: [], bare: true }] },
        }),
      ),
    ).toBe('adds an agent skill (remember:true)')
    expect(builtinUpdateProblem(bundled, manifest({ contributes: { verb: 'csv' } }))).toBe(
      'changes its verb',
    )
  })
})
