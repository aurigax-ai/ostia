pub mod browser_device;
pub mod dir_watch;
pub mod js_text;
pub mod patterns;
pub mod saved_scrollback;
pub mod stored_resume;
pub mod view_host;
pub mod workspace_merge;
pub mod workspace_registry;
pub mod tray;
pub mod window_book;
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
