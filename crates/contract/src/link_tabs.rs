pub fn is_tab_url(url: &str) -> bool {
    let bytes = url.as_bytes();
    let scheme_len = if bytes.len() >= 8 && bytes[..5].eq_ignore_ascii_case(b"https") {
        5
    } else if bytes.len() >= 7 && bytes[..4].eq_ignore_ascii_case(b"http") {
        4
    } else {
        return false;
    };
    bytes[scheme_len..].starts_with(b"://")
}
