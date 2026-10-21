import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ExtensionAgentPlugin } from './ExtensionAgentPlugin'

function extension(overrides: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: 'kit',
    name: 'Kit',
    version: '1.0.0',
    description: '',
    category: 'other',
    builtin: false,
    enabled: true,
    status: 'running',
    requested: ['agent-plugin'],
    granted: ['agent-plugin'],
    unapproved: [],
    commands: [],
    panel: null,
    paneChips: [],
    workspaceChips: [],
    settings: [],
    settingValues: {},
    settingsPage: null,
    assist: [],
    secrets: [],
    secretsSet: [],
    connectionKinds: [],
    iconThemes: [],
    languages: [],
    keymaps: [],
    languageServers: [],
    fileKinds: [],
    agentSkills: ['kit-review'],
    agentSkillProblems: [],
    agentHooks: [],
    ...overrides,
  }
}

describe('ExtensionAgentPlugin', () => {
  it('shows why a skill was refused next to the skills it still adds', () => {
    const problem = "agent skill 'review': SKILL.md: line 4: 'allowed-tools' is not allowed"
    render(
      <ExtensionAgentPlugin ext={extension({ agentSkillProblems: [problem] })} explain={false} />,
    )
    expect(screen.getByText(`Not added to the agent: ${problem}`)).toBeInTheDocument()
    expect(screen.getByText('Agent skills: kit-review')).toBeInTheDocument()
  })

  it('shows no refusal for a clean extension', () => {
    render(<ExtensionAgentPlugin ext={extension({})} explain={false} />)
    expect(screen.queryByText(/Not added to the agent/)).toBeNull()
  })
})
