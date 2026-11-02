pub mod browser_device;
pub mod context_menu_template;
pub mod dir_watch;
pub mod global_hotkey;
pub mod js_text;
pub mod patterns;
pub mod primary_selection;
pub mod quit_plan;
pub mod quit_prompt;
pub mod saved_scrollback;
pub mod stored_resume;
pub mod view_host;
pub mod workspace_merge;
pub mod workspace_registry;
pub mod workspace_snapshot;
pub mod workspace_text;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanePlacementZone {
    Left,
    Right,
    Top,
    Bottom,
    Center,
}
