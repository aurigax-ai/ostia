use ostia_base::js::utf16_len;

const PATH_ELLIPSIS: &str = "…";

fn split_path(path: &str) -> (&str, Vec<&str>) {
    let trimmed = if utf16_len(path) > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    let mut parts = trimmed.split('/');
    let head = parts.next().unwrap_or_default();
    (head, parts.filter(|part| !part.is_empty()).collect())
}

pub fn path_candidates(path: &str) -> Vec<String> {
    let (head, segments) = split_path(path);
    if segments.len() < 2 {
        return vec![path.to_owned()];
    }
    let limit = utf16_len(path);
    let mut shorter: Vec<String> = (1..segments.len())
        .rev()
        .map(|keep| {
            let tail = &segments[segments.len() - keep..];
            format!("{head}/{PATH_ELLIPSIS}/{}", tail.join("/"))
        })
        .collect();
    shorter.extend(segments.last().map(|last| (*last).to_owned()));
    std::iter::once(path.to_owned())
        .chain(
            shorter
                .into_iter()
                .filter(|candidate| utf16_len(candidate) < limit),
        )
        .collect()
}

pub fn shorten_path(path: &str, max_chars: usize) -> String {
    let candidates = path_candidates(path);
    candidates
        .iter()
        .find(|candidate| utf16_len(candidate) <= max_chars)
        .or(candidates.last())
        .cloned()
        .unwrap_or_default()
}

pub struct FitInput {
    pub widths: Vec<f64>,
    pub available: f64,
    pub gap: f64,
    pub more_width: f64,
    pub first_min: Option<f64>,
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

pub fn fit_count(input: &FitInput) -> usize {
    let shrunk: Vec<f64> = input
        .widths
        .iter()
        .enumerate()
        .map(|(i, &width)| match (i, input.first_min) {
            (0, Some(min)) => js_min(width, min),
            _ => width,
        })
        .collect();
    let total = shrunk.iter().enumerate().fold(0.0, |sum, (i, &width)| {
        sum + width + if i > 0 { input.gap } else { 0.0 }
    });
    if total <= input.available {
        return input.widths.len();
    }
    let mut used = input.more_width;
    let mut count = 0;
    for width in shrunk {
        let next = used + input.gap + width;
        if next > input.available {
            break;
        }
        used = next;
        count += 1;
    }
    count.max(1)
}
