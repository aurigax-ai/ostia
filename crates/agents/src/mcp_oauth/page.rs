use ostia_base::js::{is_js_space, js_trim};
use ostia_contract::utf16_prefix::utf16_prefix;

const DETAIL_MAX: usize = 240;

pub(super) fn clip(text: &str) -> String {
    let mut collapsed = String::new();
    let mut in_space = false;
    for ch in text.chars() {
        if is_js_space(ch) {
            in_space = true;
            continue;
        }
        if in_space {
            collapsed.push(' ');
            in_space = false;
        }
        collapsed.push(ch);
    }
    if in_space {
        collapsed.push(' ');
    }
    utf16_prefix(js_trim(&collapsed), DETAIL_MAX).to_owned()
}

pub(super) fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}
