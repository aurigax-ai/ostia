pub fn decode_command_line(encoded: &str) -> String {
    let mut out = String::with_capacity(encoded.len());
    let mut rest = encoded;
    while let Some(ch) = rest.chars().next() {
        if ch == '\\' {
            let after = &rest[1..];
            if let Some(tail) = after.strip_prefix('\\') {
                out.push('\\');
                rest = tail;
                continue;
            }
            if let Some(byte) = hex_escape(after) {
                out.push(char::from(byte));
                rest = &after[3..];
                continue;
            }
        }
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn hex_escape(after_backslash: &str) -> Option<u8> {
    let digits = after_backslash.strip_prefix('x')?.as_bytes().get(..2)?;
    if !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let text = std::str::from_utf8(digits).ok()?;
    u8::from_str_radix(text, 16).ok()
}
