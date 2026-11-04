use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

const DEVICE_NAME_MAX: usize = 64;

static UNSAFE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]"));

pub fn clean_device_name(name: &str) -> Option<String> {
    if UNSAFE.is_match(name) {
        return None;
    }
    let kept: String = js_trim(name)
        .graphemes(true)
        .take(DEVICE_NAME_MAX)
        .collect();
    let trimmed = js_trim(&kept);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}
