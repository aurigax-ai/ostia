use serde_json::Value;

fn escaped_unit(bytes: &[u8], at: usize) -> Option<u16> {
    let escape = bytes.get(at..at + 6)?;
    if escape[0] != b'\\' || escape[1] != b'u' {
        return None;
    }
    let digits = std::str::from_utf8(&escape[2..]).ok()?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(digits, 16).ok()
}

fn replace_lone_surrogates(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            out.push(bytes[at]);
            at += 1;
            continue;
        }
        match escaped_unit(bytes, at) {
            Some(0xD800..=0xDBFF)
                if matches!(escaped_unit(bytes, at + 6), Some(0xDC00..=0xDFFF)) =>
            {
                out.extend_from_slice(&bytes[at..at + 12]);
                at += 12;
            }
            Some(0xD800..=0xDFFF) => {
                out.extend_from_slice(b"\\ufffd");
                at += 6;
            }
            Some(_) => {
                out.extend_from_slice(&bytes[at..at + 6]);
                at += 6;
            }
            None => {
                out.extend_from_slice(&bytes[at..bytes.len().min(at + 2)]);
                at += 2;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_js_json(text: &str) -> serde_json::Result<Value> {
    serde_json::from_str(&replace_lone_surrogates(text))
}
