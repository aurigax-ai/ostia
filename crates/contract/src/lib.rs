pub mod agent_launch;
pub mod agent_resume;
pub mod agent_skills;
pub mod argv;
pub mod capabilities;
pub mod command_line;
pub mod commands;
pub mod extensions;
pub mod hidden_text;
pub mod keep_shells;
pub mod open_files;
pub mod osc7;
pub mod reach;
pub mod sandbox;
pub mod script_tokens;
pub mod terminal_state;

pub const TARGET_PANE_PARAM: &str = "targetPaneId";
pub const SANDBOXED_REFUSAL: &str =
    "sandboxed: a sandboxed workspace reaches only the sandboxed terminals of its own workspace";
pub const PRODUCT_DISPLAY_NAME: &str = "Ostia";
