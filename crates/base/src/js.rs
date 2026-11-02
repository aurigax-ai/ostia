use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::CollatorBorrowed;
use icu_collator::options::CollatorOptions;
use regex::Regex;

static COLLATOR: LazyLock<CollatorBorrowed<'static>> =
    LazyLock::new(|| CollatorBorrowed::new_root(CollatorOptions::default()));

pub fn locale_compare(left: &str, right: &str) -> Ordering {
    COLLATOR.compare(left, right)
}

pub const JS_SPACE_CLASS: &str = r"\t\n\x0b\x0c\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

pub const JS_DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

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

pub fn non_empty(text: Option<&str>) -> Option<&str> {
    text.filter(|value| !value.is_empty())
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

fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let bits_per_digit = radix.trailing_zeros();
    let mut kept: u128 = 0;
    let mut dropped_bits: i32 = 0;
    let mut sticky = false;
    for ch in digits.chars() {
        let Some(digit) = ch.to_digit(radix) else {
            return f64::NAN;
        };
        for shift in (0..bits_per_digit).rev() {
            let bit = (digit >> shift) & 1 == 1;
            if kept >> 127 == 0 {
                kept = (kept << 1) | u128::from(bit);
            } else {
                dropped_bits = dropped_bits.saturating_add(1);
                sticky |= bit;
            }
        }
    }
    if sticky {
        kept |= 1;
    }
    (kept as f64) * 2f64.powi(dropped_bits)
}

fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.strip_prefix(['+', '-']).unwrap_or(text).as_bytes();
    let count = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    let whole = count(0);
    let mut at = whole;
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        fraction = count(at + 1);
        at += 1 + fraction;
    }
    if whole + fraction == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = count(at);
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == bytes.len()
}

pub fn js_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let prefix = text.get(..2).unwrap_or("");
    match prefix {
        "0x" | "0X" => return radix_number(&text[2..], 16),
        "0o" | "0O" => return radix_number(&text[2..], 8),
        "0b" | "0B" => return radix_number(&text[2..], 2),
        _ => {}
    }
    if !is_decimal_literal(text) {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}
