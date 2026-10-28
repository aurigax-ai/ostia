export const AGENT_READ_TOOLS = [
  'ostia_workspaces',
  'ostia_panes',
  'ostia_managed',
  'ostia_bus_inbox',
] as const

export const AGENT_ACT_TOOLS = ['ostia_agent_run', 'ostia_bus_send'] as const

export type AgentActTool = (typeof AGENT_ACT_TOOLS)[number]

export type AgentCoreToolName = (typeof AGENT_READ_TOOLS)[number] | AgentActTool

export function isAgentCoreTool(name: string): name is AgentCoreToolName {
  return (
    (AGENT_READ_TOOLS as readonly string[]).includes(name) ||
    (AGENT_ACT_TOOLS as readonly string[]).includes(name)
  )
}

export function isAgentActTool(name: string): name is AgentActTool {
  return (AGENT_ACT_TOOLS as readonly string[]).includes(name)
}
