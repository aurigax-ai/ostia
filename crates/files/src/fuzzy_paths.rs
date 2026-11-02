use ostia_base::js::is_js_space;

#[derive(Clone, Debug, PartialEq)]
pub struct FuzzyHit {
    pub path: String,
    pub score: f64,
    pub positions: Vec<usize>,
}

const NAME_ONLY_BONUS: f64 = 10.0;

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn is_separator(unit: u16) -> bool {
    b"/\\_-. ".contains(&u8::try_from(unit).unwrap_or(0))
}

fn is_lower_stable(unit: u16) -> bool {
    match char::from_u32(u32::from(unit)) {
        Some(ch) => ch.to_lowercase().eq(std::iter::once(ch)),
        None => true,
    }
}

fn is_word_start(path: &[u16], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let Some(&prev) = path.get(index - 1) else {
        return false;
    };
    if is_separator(prev) {
        return true;
    }
    is_lower_stable(prev) && path.get(index).is_some_and(|&unit| !is_lower_stable(unit))
}

fn score_of(path: &[u16], positions: &[usize]) -> f64 {
    let base = path
        .iter()
        .rposition(|&unit| unit == u16::from(b'/'))
        .map_or(0, |at| at + 1);
    let mut score = 0.0;
    for (i, &pos) in positions.iter().enumerate() {
        score += 1.0;
        if i > 0 && positions[i - 1] + 1 == pos {
            score += 5.0;
        }
        if is_word_start(path, pos) {
            score += 8.0;
        }
        if pos >= base {
            score += 2.0;
        }
    }
    if positions[0] >= base {
        score += NAME_ONLY_BONUS;
    }
    let span = positions[positions.len() - 1] as f64 - positions[0] as f64 + 1.0;
    score - (span - positions.len() as f64) * 0.2 - path.len() as f64 * 0.01
}

fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

fn last_index_of(haystack: &[u16], needle: &[u16], from: isize) -> Option<usize> {
    let start = usize::try_from(from).unwrap_or(0);
    let last = haystack.len().checked_sub(needle.len())?;
    (0..=start.min(last))
        .rev()
        .find(|&at| &haystack[at..at + needle.len()] == needle)
}

fn forward(lower: &[u16], query: &str) -> Option<Vec<usize>> {
    let mut positions = Vec::new();
    let mut from = 0;
    for ch in query.chars() {
        let mut buffer = [0u16; 2];
        let needle = ch.encode_utf16(&mut buffer);
        let at = index_of(lower, needle, from)?;
        positions.push(at);
        from = at + 1;
    }
    Some(positions)
}

fn backward(lower: &[u16], query: &[u16]) -> Option<Vec<usize>> {
    let mut positions = Vec::new();
    let mut from = lower.len() as isize - 1;
    for unit in query.iter().rev() {
        let at = last_index_of(lower, std::slice::from_ref(unit), from)?;
        positions.push(at);
        from = at as isize - 1;
    }
    positions.reverse();
    Some(positions)
}

pub fn fuzzy_match(raw_query: &str, path: &str) -> Option<FuzzyHit> {
    let query: String = raw_query
        .to_lowercase()
        .chars()
        .filter(|&ch| !is_js_space(ch))
        .collect();
    if query.is_empty() {
        return None;
    }
    let lower = utf16(&path.to_lowercase());
    let units = utf16(path);
    let query_units = utf16(&query);
    let mut best: Option<FuzzyHit> = None;
    for positions in [backward(&lower, &query_units), forward(&lower, &query)] {
        let Some(positions) = positions else {
            continue;
        };
        let score = score_of(&units, &positions);
        if best.as_ref().is_none_or(|hit| score > hit.score) {
            best = Some(FuzzyHit {
                path: path.to_owned(),
                score,
                positions,
            });
        }
    }
    best
}
