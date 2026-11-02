use std::collections::HashMap;

use super::tree::find_pane;
use super::types::LayoutNode;

pub fn pane_title_in(layouts: &HashMap<String, LayoutNode>, pane_id: &str) -> Option<String> {
    layouts
        .values()
        .find_map(|root| find_pane(root, pane_id))
        .map(|pane| pane.title.clone())
}
