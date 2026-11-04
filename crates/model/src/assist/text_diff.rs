use std::rc::Rc;

use ostia_base::js::is_js_space;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub added: bool,
    pub removed: bool,
    pub value: String,
}

struct Component {
    count: usize,
    added: bool,
    removed: bool,
    previous: Option<Rc<Component>>,
}

#[derive(Clone)]
struct Path {
    old_pos: isize,
    last: Option<Rc<Component>>,
}

fn len_of(tokens: &[String]) -> isize {
    isize::try_from(tokens.len()).unwrap_or(isize::MAX)
}

fn add_to_path(path: &Path, added: bool, removed: bool, old_pos_inc: isize) -> Path {
    let component = match &path.last {
        Some(last) if last.added == added && last.removed == removed => Component {
            count: last.count + 1,
            added,
            removed,
            previous: last.previous.clone(),
        },
        last => Component {
            count: 1,
            added,
            removed,
            previous: last.clone(),
        },
    };
    Path {
        old_pos: path.old_pos + old_pos_inc,
        last: Some(Rc::new(component)),
    }
}

fn token_at(tokens: &[String], index: isize) -> Option<&String> {
    usize::try_from(index).ok().and_then(|at| tokens.get(at))
}

fn extract_common(
    path: &mut Path,
    new_tokens: &[String],
    old_tokens: &[String],
    diagonal: isize,
) -> isize {
    let new_len = len_of(new_tokens);
    let old_len = len_of(old_tokens);
    let mut old_pos = path.old_pos;
    let mut new_pos = old_pos - diagonal;
    let mut common = 0;
    while new_pos + 1 < new_len
        && old_pos + 1 < old_len
        && token_at(old_tokens, old_pos + 1) == token_at(new_tokens, new_pos + 1)
    {
        new_pos += 1;
        old_pos += 1;
        common += 1;
    }
    if common > 0 {
        path.last = Some(Rc::new(Component {
            count: common,
            added: false,
            removed: false,
            previous: path.last.take(),
        }));
    }
    path.old_pos = old_pos;
    new_pos
}

fn build_values(
    last: Option<Rc<Component>>,
    new_tokens: &[String],
    old_tokens: &[String],
) -> Vec<Change> {
    let mut components = Vec::new();
    let mut next = last;
    while let Some(component) = next {
        next = component.previous.clone();
        components.push(component);
    }
    components.reverse();
    let mut new_pos = 0;
    let mut old_pos = 0;
    let mut changes = Vec::with_capacity(components.len());
    for component in components {
        let value = if component.removed {
            let value = old_tokens[old_pos..old_pos + component.count].concat();
            old_pos += component.count;
            value
        } else {
            let value = new_tokens[new_pos..new_pos + component.count].concat();
            new_pos += component.count;
            if !component.added {
                old_pos += component.count;
            }
            value
        };
        changes.push(Change {
            added: component.added,
            removed: component.removed,
            value,
        });
    }
    changes
}

fn diagonal_slot(diagonal: isize, offset: isize) -> usize {
    usize::try_from(diagonal + offset).unwrap_or(0)
}

fn diff_tokens(
    old_tokens: &[String],
    new_tokens: &[String],
    max_edit_length: Option<usize>,
) -> Option<Vec<Change>> {
    let new_len = len_of(new_tokens);
    let old_len = len_of(old_tokens);
    let mut max_edit = new_len + old_len;
    if let Some(limit) = max_edit_length {
        max_edit = max_edit.min(isize::try_from(limit).unwrap_or(isize::MAX));
    }
    let offset = max_edit + 2;
    let mut best: Vec<Option<Path>> = vec![None; diagonal_slot(max_edit + 2, offset) + 1];
    let mut seed = Path {
        old_pos: -1,
        last: None,
    };
    let seed_new_pos = extract_common(&mut seed, new_tokens, old_tokens, 0);
    if seed.old_pos + 1 >= old_len && seed_new_pos + 1 >= new_len {
        return Some(build_values(seed.last, new_tokens, old_tokens));
    }
    best[diagonal_slot(0, offset)] = Some(seed);
    let mut min_diagonal = isize::MIN;
    let mut max_diagonal = isize::MAX;
    let mut edit_length: isize = 1;
    while edit_length <= max_edit {
        let mut diagonal = min_diagonal.max(-edit_length);
        let highest = max_diagonal.min(edit_length);
        while diagonal <= highest {
            let remove_slot = diagonal_slot(diagonal - 1, offset);
            let add_slot = diagonal_slot(diagonal + 1, offset);
            let remove_path = best[remove_slot].take();
            let add_path = best[add_slot].clone();
            let can_add = add_path.as_ref().is_some_and(|path| {
                let add_new_pos = path.old_pos - diagonal;
                0 <= add_new_pos && add_new_pos < new_len
            });
            let can_remove = remove_path
                .as_ref()
                .is_some_and(|path| path.old_pos + 1 < old_len);
            let take_add = !can_remove
                || (can_add
                    && matches!((&remove_path, &add_path),
                        (Some(remove), Some(add)) if remove.old_pos < add.old_pos));
            let source = if take_add {
                add_path
                    .as_ref()
                    .map(|path| add_to_path(path, true, false, 0))
            } else {
                remove_path
                    .as_ref()
                    .map(|path| add_to_path(path, false, true, 1))
            };
            let slot = diagonal_slot(diagonal, offset);
            let Some(mut base) = source.filter(|_| can_add || can_remove) else {
                best[slot] = None;
                diagonal += 2;
                continue;
            };
            let new_pos = extract_common(&mut base, new_tokens, old_tokens, diagonal);
            if base.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
                return Some(build_values(base.last, new_tokens, old_tokens));
            }
            if base.old_pos + 1 >= old_len {
                max_diagonal = max_diagonal.min(diagonal - 1);
            }
            if new_pos + 1 >= new_len {
                min_diagonal = min_diagonal.max(diagonal + 1);
            }
            best[slot] = Some(base);
            diagonal += 2;
        }
        edit_length += 1;
    }
    None
}

fn is_extended_word_char(ch: char) -> bool {
    matches!(ch,
        'a'..='z' | 'A'..='Z' | '0'..='9' | '_'
        | '\u{AD}' | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{2C6}'
        | '\u{2C8}'..='\u{2D7}' | '\u{2DE}'..='\u{2FF}' | '\u{1E00}'..='\u{1EFF}')
}

fn is_inline_space(ch: char) -> bool {
    is_js_space(ch) && ch != '\n' && ch != '\r'
}

fn take_run(rest: &str, member: fn(char) -> bool) -> usize {
    rest.char_indices()
        .find(|(_, ch)| !member(*ch))
        .map_or(rest.len(), |(at, _)| at)
}

fn word_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = text;
    while let Some(first) = rest.chars().next() {
        let length = if first == '\n' {
            1
        } else if first == '\r' && rest[1..].starts_with('\n') {
            2
        } else if is_extended_word_char(first) {
            take_run(rest, is_extended_word_char)
        } else if is_inline_space(first) {
            take_run(rest, is_inline_space)
        } else {
            first.len_utf8()
        };
        tokens.push(rest[..length].to_owned());
        rest = &rest[length..];
    }
    tokens
}

fn line_tokens(text: &str) -> Vec<String> {
    text.split_inclusive('\n').map(str::to_owned).collect()
}

pub fn diff_words_with_space(
    before: &str,
    after: &str,
    max_edit_length: Option<usize>,
) -> Option<Vec<Change>> {
    diff_tokens(&word_tokens(before), &word_tokens(after), max_edit_length)
}

pub fn diff_lines(before: &str, after: &str) -> Vec<Change> {
    diff_tokens(&line_tokens(before), &line_tokens(after), None).unwrap_or_default()
}
