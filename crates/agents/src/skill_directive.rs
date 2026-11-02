use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

static LINE_BREAKS: LazyLock<Regex> =
    LazyLock::new(|| static_regex("\r\n|[\n\r\u{85}\u{2028}\u{2029}]"));
static INLINE_INJECTION: LazyLock<Regex> =
    LazyLock::new(|| static_regex("[!\u{1c3}][`\u{2cb}\u{2f4}\u{2035}$]"));
static FENCED_INJECTION: LazyLock<Regex> =
    LazyLock::new(|| static_regex("(?:[`\u{2cb}\u{2f4}\u{2035}]{3,}|~{3,})[ \t]*[!\u{1c3}$]"));

pub fn skill_directive(text: &str) -> Option<String> {
    LINE_BREAKS
        .split(text)
        .enumerate()
        .find_map(|(index, line)| {
            let flat: String = line.nfkc().collect();
            (INLINE_INJECTION.is_match(&flat) || FENCED_INJECTION.is_match(&flat)).then(|| {
                format!(
                    "line {}: shell injection (!` or a ```! block) is not allowed",
                    index + 1
                )
            })
        })
}
