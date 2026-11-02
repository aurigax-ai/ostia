use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;

static VIEW_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]{0,39}$"));
static EXTENSION_ID: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{1,39}$"));
static FILE_KIND_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9-]{0,39}$"));
static WINDOW_ID: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[A-Za-z0-9-]{1,40}$"));

pub fn is_view_name(value: &str) -> bool {
    VIEW_NAME.is_match(value)
}

pub fn is_extension_id(value: &str) -> bool {
    EXTENSION_ID.is_match(value)
}

pub fn is_view_type(value: &str) -> bool {
    value == "default" || FILE_KIND_ID.is_match(value)
}

pub fn is_window_id(value: &str) -> bool {
    WINDOW_ID.is_match(value)
}

pub fn is_remote_path(value: &str) -> bool {
    value.starts_with("remote://")
}
