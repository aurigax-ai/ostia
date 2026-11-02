use ostia_base::js::{js_trim, utf16_len};
use serde_json::Value;

pub const MATCH_OSTIA_THEME: &str = "match";

const ID_MAX: usize = 80;

pub fn parse_theme_choice(raw: &Value) -> String {
    let Some(text) = raw.as_str() else {
        return MATCH_OSTIA_THEME.to_owned();
    };
    let id = js_trim(text);
    if id.is_empty() || utf16_len(id) > ID_MAX {
        MATCH_OSTIA_THEME.to_owned()
    } else {
        id.to_owned()
    }
}

pub fn is_linked_theme(choice: &str) -> bool {
    choice == MATCH_OSTIA_THEME
}
