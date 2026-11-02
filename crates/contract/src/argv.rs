use ostia_base::js::is_js_space;

pub fn split_args(line: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut quote: Option<char> = None;
    for ch in line.chars() {
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            in_token = true;
        } else if is_js_space(ch) {
            if in_token {
                tokens.push(std::mem::take(&mut current));
            }
            current.clear();
            in_token = false;
        } else {
            current.push(ch);
            in_token = true;
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_token {
        tokens.push(current);
    }
    Some(tokens)
}
