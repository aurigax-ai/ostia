use ostia_base::js::js_trim;
use serde_json::Value;

use crate::text_cut::utf16_prefix;

pub const WORKSPACE_GROUP_COLORS: [&str; 8] = [
    "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink",
];

const WORKSPACE_GROUP_NAME_MAX: usize = 60;

pub fn is_workspace_group_color(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|color| WORKSPACE_GROUP_COLORS.contains(&color))
}

pub fn normalize_group_name(raw: &Value) -> Option<String> {
    let cut = utf16_prefix(js_trim(raw.as_str()?), WORKSPACE_GROUP_NAME_MAX);
    let name = js_trim(&cut);
    (!name.is_empty()).then(|| name.to_owned())
}
