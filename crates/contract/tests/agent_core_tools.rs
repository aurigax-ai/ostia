#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_core_tools::{
    AGENT_ACT_TOOLS, AGENT_READ_TOOLS, is_agent_act_tool, is_agent_core_tool,
};

#[test]
fn lists_the_read_tools_and_the_acting_tools_in_order() {
    assert_eq!(
        AGENT_READ_TOOLS,
        [
            "ostia_workspaces",
            "ostia_panes",
            "ostia_managed",
            "ostia_bus_inbox",
            "ostia_pane_read",
            "ostia_pane_wait",
            "ostia_skill",
        ]
    );
    assert_eq!(AGENT_ACT_TOOLS, ["ostia_agent_run", "ostia_bus_send"]);
}

#[test]
fn knows_every_read_tool_and_every_acting_tool_as_a_core_tool() {
    for name in AGENT_READ_TOOLS.iter().chain(AGENT_ACT_TOOLS.iter()) {
        assert!(is_agent_core_tool(name), "{name}");
    }
}

#[test]
fn refuses_names_that_are_not_core_tools() {
    for name in [
        "",
        "open_url",
        "ostia",
        "OSTIA_PANES",
        "ostia_panes ",
        "ostia_bus_send2",
        "ostia_",
    ] {
        assert!(!is_agent_core_tool(name), "{name:?}");
    }
}

#[test]
fn marks_only_the_acting_tools_as_acting() {
    for name in AGENT_ACT_TOOLS {
        assert!(is_agent_act_tool(name), "{name}");
    }
    for name in AGENT_READ_TOOLS {
        assert!(!is_agent_act_tool(name), "{name}");
    }
    assert!(!is_agent_act_tool("open_url"));
    assert!(!is_agent_act_tool(""));
}
