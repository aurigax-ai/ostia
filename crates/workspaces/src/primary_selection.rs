use ostia_base::js::utf16_len;
use serde_json::Value;

pub const PRIMARY_SELECTION_MAX_CHARS: usize = 1024 * 1024;

pub fn accepts_primary_selection(platform: &str, text: &Value) -> bool {
    platform == "linux"
        && text
            .as_str()
            .is_some_and(|text| !text.is_empty() && utf16_len(text) <= PRIMARY_SELECTION_MAX_CHARS)
}
