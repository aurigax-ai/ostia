pub mod agent_issues;
pub mod agent_launch;
pub mod agent_resume;
pub mod agent_skills;
pub mod agent_stream;
pub mod agent_work;
pub mod capabilities;
pub mod commands;
pub mod extensions;
pub mod finished_hibernate;
pub mod hidden_text;
pub mod hook_payload;
pub mod open_files;
pub mod reach;
pub mod sandbox;
pub mod script_tokens;
pub mod terminal_state;
pub mod turn_hook;
pub mod utf16_prefix;

pub const TARGET_PANE_PARAM: &str = "targetPaneId";
pub const SANDBOXED_REFUSAL: &str =
    "sandboxed: a sandboxed workspace reaches only the sandboxed terminals of its own workspace";
pub const PRODUCT_DISPLAY_NAME: &str = "Ostia";
