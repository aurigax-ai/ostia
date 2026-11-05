pub const AGENT_READ_TOOLS: [&str; 7] = [
    "ostia_workspaces",
    "ostia_panes",
    "ostia_managed",
    "ostia_bus_inbox",
    "ostia_pane_read",
    "ostia_pane_wait",
    "ostia_skill",
];

pub const AGENT_ACT_TOOLS: [&str; 2] = ["ostia_agent_run", "ostia_bus_send"];

pub fn is_agent_core_tool(name: &str) -> bool {
    AGENT_READ_TOOLS.contains(&name) || is_agent_act_tool(name)
}

pub fn is_agent_act_tool(name: &str) -> bool {
    AGENT_ACT_TOOLS.contains(&name)
}
