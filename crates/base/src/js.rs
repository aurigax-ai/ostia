use regex::Regex;

pub const JS_SPACE_CLASS: &str = r"\t\n\x0b\x0c\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

#[allow(clippy::expect_used)]
pub fn static_regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a constant pattern compiles")
}

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

pub fn is_js_space(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn parse_safe_int(text: &str) -> Option<i64> {
    let rest = js_trim(text);
    let (negative, rest) = match rest.strip_prefix('-') {
        Some(after) => (true, after),
        None => (false, rest.strip_prefix('+').unwrap_or(rest)),
    };
    let (radix, rest) = match rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")) {
        Some(after) => (16, after),
        None => (10, rest),
    };
    let digits = rest
        .find(|ch: char| !ch.is_digit(radix))
        .unwrap_or(rest.len());
    if digits == 0 {
        return None;
    }
    let value = i64::from_str_radix(&rest[..digits], radix).ok()?;
    if value > MAX_SAFE_INTEGER {
        return None;
    }
    Some(if negative { -value } else { value })
}
