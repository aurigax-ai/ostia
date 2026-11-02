use serde_json::Value;

pub const KEEP_SHELLS_FEATURE: &str = "keep-shells";
pub const TMUX_MIN_VERSION: &str = "3.2";
pub const KEPT_SHELLS_DIR: &str = "kept-shells";

pub fn parse_keep_shells(raw: &Value) -> bool {
    raw == &Value::Bool(true)
}
