use ostia_base::js::{js_trim, utf16_len};
use serde_json::Value;

use crate::text_cut::utf16_prefix;

const WORKSPACE_DESCRIPTION_MAX: usize = 500;

pub fn normalize_description(raw: &Value) -> Option<String> {
    let text = js_trim(raw.as_str()?);
    if text.is_empty() {
        return None;
    }
    if utf16_len(text) > WORKSPACE_DESCRIPTION_MAX {
        Some(format!(
            "{}…",
            utf16_prefix(text, WORKSPACE_DESCRIPTION_MAX - 1)
        ))
    } else {
        Some(text.to_owned())
    }
}
