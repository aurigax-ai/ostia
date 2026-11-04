use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;

static NOT_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(
        r"^(?:~|[Nn]ull|NULL|[Tt]rue|TRUE|[Ff]alse|FALSE|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$",
    )
});

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct FrontMatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

enum Value {
    Text(String),
    Other,
}

struct Entry<'a> {
    key: String,
    rest: &'a str,
    continuation: Vec<&'a str>,
}

pub(crate) fn parse(meta: &str) -> Option<FrontMatter> {
    let mut found = FrontMatter::default();
    for entry in entries(meta)? {
        if let Value::Text(text) = value_of(entry.rest.trim(), &entry.continuation)? {
            match entry.key.as_str() {
                "name" => found.name = Some(text),
                "description" => found.description = Some(text),
                _ => {}
            }
        }
    }
    Some(found)
}

fn entries(meta: &str) -> Option<Vec<Entry<'_>>> {
    let mut out: Vec<Entry<'_>> = Vec::new();
    for raw in meta.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.trim().is_empty() {
            if let Some(last) = out.last_mut() {
                last.continuation.push("");
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with([' ', '\t']) {
            out.last_mut()?.continuation.push(line);
            continue;
        }
        let (key, rest) = split_key(line)?;
        if out.iter().any(|entry| entry.key == key) {
            return None;
        }
        out.push(Entry {
            key,
            rest,
            continuation: Vec::new(),
        });
    }
    (!out.is_empty()).then_some(out)
}

fn split_key(line: &str) -> Option<(String, &str)> {
    if line == "-" || line.starts_with("- ") {
        return None;
    }
    if line.starts_with(['"', '\'']) {
        let end = quoted_end(line)?;
        let key = unquote(line.get(..end)?)?;
        let rest = line.get(end..)?.trim_start().strip_prefix(':')?;
        return rest
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
            .then_some((key, rest));
    }
    let at = line.char_indices().find_map(|(index, c)| {
        let after = line.get(index + 1..)?;
        (c == ':' && after.chars().next().is_none_or(char::is_whitespace)).then_some(index)
    })?;
    let key = line.get(..at)?.trim_end();
    if key.is_empty() || key.starts_with(['[', '{', '&', '*', '!', '|', '>', '%', '@', '`']) {
        return None;
    }
    Some((key.to_owned(), line.get(at + 1..)?))
}

fn value_of(rest: &str, continuation: &[&str]) -> Option<Value> {
    let lines: Vec<&str> = continuation
        .iter()
        .copied()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect();
    match rest.chars().next() {
        None => Some(empty_value(&lines)),
        Some('|' | '>') => block_scalar(rest, continuation),
        Some('"' | '\'') => quoted_value(rest, &lines),
        Some('[' | '{') => flow_value(rest, &lines),
        Some('*' | '@' | '`' | '%') => None,
        Some('!') => Some(Value::Other),
        Some('&') => {
            let after = rest
                .split_once(char::is_whitespace)
                .map_or("", |(_, tail)| tail.trim());
            value_of(after, continuation)
        }
        Some(_) => plain_value(rest, &lines),
    }
}

fn empty_value(lines: &[&str]) -> Value {
    let Some(first) = lines
        .iter()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
    else {
        return Value::Other;
    };
    if first == "-" || first.starts_with("- ") || first.contains(": ") || first.ends_with(':') {
        return Value::Other;
    }
    classify(fold(lines.iter().map(|line| strip_comment(line))))
}

fn plain_value(rest: &str, lines: &[&str]) -> Option<Value> {
    let text = fold(
        std::iter::once(strip_comment(rest)).chain(lines.iter().map(|line| strip_comment(line))),
    );
    if text.contains(": ") || text.ends_with(':') {
        return None;
    }
    Some(classify(text))
}

fn classify(text: String) -> Value {
    if NOT_TEXT.is_match(&text) {
        Value::Other
    } else {
        Value::Text(text)
    }
}

fn strip_comment(line: &str) -> &str {
    let trimmed = line.trim();
    match trimmed.find(" #") {
        Some(at) => trimmed.get(..at).unwrap_or(trimmed).trim_end(),
        None => trimmed,
    }
}

fn fold<'a>(parts: impl Iterator<Item = &'a str>) -> String {
    parts
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn block_scalar(header: &str, continuation: &[&str]) -> Option<Value> {
    let marker = header
        .split_once(" #")
        .map_or(header, |(head, _)| head)
        .trim();
    let folded = marker.starts_with('>');
    if !marker
        .chars()
        .skip(1)
        .all(|c| matches!(c, '+' | '-' | '0'..='9'))
    {
        return None;
    }
    let indent = continuation
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    let lines: Vec<&str> = continuation
        .iter()
        .map(|line| line.get(indent..).unwrap_or(""))
        .collect();
    let text = lines.join(if folded { " " } else { "\n" });
    Some(Value::Text(text))
}

fn quoted_end(text: &str) -> Option<usize> {
    let mut chars = text.char_indices();
    let (_, quote) = chars.next()?;
    let mut escaped = false;
    while let Some((index, c)) = chars.next() {
        if quote == '"' {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                return Some(index + 1);
            }
        } else if c == '\'' {
            if text.get(index + 1..)?.starts_with('\'') {
                chars.next();
            } else {
                return Some(index + 1);
            }
        }
    }
    None
}

fn quoted_value(rest: &str, lines: &[&str]) -> Option<Value> {
    let joined = std::iter::once(rest.trim())
        .chain(lines.iter().map(|line| line.trim()))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let end = quoted_end(&joined)?;
    let after = joined.get(end..)?.trim();
    if !after.is_empty() && !after.starts_with('#') {
        return None;
    }
    Some(Value::Text(unquote(joined.get(..end)?)?))
}

fn unquote(quoted: &str) -> Option<String> {
    let inner = quoted.get(1..quoted.len().checked_sub(1)?)?;
    if quoted.starts_with('\'') {
        return Some(inner.replace("''", "'"));
    }
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        out.push(match chars.next()? {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            '0' => '\0',
            'a' => '\u{7}',
            'b' => '\u{8}',
            'f' => '\u{c}',
            'v' => '\u{b}',
            'e' => '\u{1b}',
            'N' => '\u{85}',
            '_' => '\u{a0}',
            ' ' => ' ',
            '"' => '"',
            '/' => '/',
            '\\' => '\\',
            'x' => hex_char(&mut chars, 2)?,
            'u' => hex_char(&mut chars, 4)?,
            'U' => hex_char(&mut chars, 8)?,
            _ => return None,
        });
    }
    Some(out)
}

fn hex_char(chars: &mut std::str::Chars<'_>, digits: usize) -> Option<char> {
    let mut code: u32 = 0;
    for _ in 0..digits {
        code = code
            .checked_mul(16)?
            .checked_add(chars.next()?.to_digit(16)?)?;
    }
    char::from_u32(code)
}

fn flow_value(rest: &str, lines: &[&str]) -> Option<Value> {
    let mut depth: i64 = 0;
    let mut quote: Option<char> = None;
    for c in std::iter::once(rest)
        .chain(lines.iter().copied())
        .flat_map(str::chars)
    {
        match (quote, c) {
            (Some(open), _) if c == open => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '[' | '{') => depth += 1,
            (None, ']' | '}') => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return None;
        }
    }
    (depth == 0 && quote.is_none()).then_some(Value::Other)
}
