pub fn is_control(code: u32) -> bool {
    code < 0x20 || code == 0x7f || (0x80..=0x9f).contains(&code)
}

pub fn has_control_character(text: &str) -> bool {
    text.chars().any(|ch| is_control(ch as u32))
}

pub fn is_hidden_format(code: u32) -> bool {
    code == 0x061c || (0x2028..=0x202e).contains(&code) || (0x2066..=0x2069).contains(&code)
}

pub fn code_escape(code: u32) -> String {
    if code <= 0xff {
        format!("\\x{code:02x}")
    } else {
        format!("\\u{code:04x}")
    }
}
