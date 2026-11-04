pub const FOLDED_CRUMB: &str = "…";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Crumb {
    pub key: String,
    pub label: String,
}

fn crumb(key: &str, label: &str) -> Crumb {
    Crumb {
        key: key.to_owned(),
        label: label.to_owned(),
    }
}

fn segment_crumbs(rest: &str, base: &str) -> Vec<Crumb> {
    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    parts
        .iter()
        .enumerate()
        .map(|(index, label)| Crumb {
            key: format!("{base}/{}", parts[..=index].join("/")),
            label: (*label).to_owned(),
        })
        .collect()
}

fn trimmed_home(home: Option<&str>) -> Option<&str> {
    let home = home.filter(|home| !home.is_empty() && *home != "/")?;
    Some(home.trim_end_matches('/')).filter(|home| !home.is_empty())
}

pub fn crumbs_of(path: &str, home: Option<&str>) -> Vec<Crumb> {
    if path == "~" || path.starts_with("~/") {
        let mut crumbs = vec![crumb("~", "~")];
        crumbs.extend(segment_crumbs(&path[1..], "~"));
        return crumbs;
    }
    if let Some(home) = trimmed_home(home)
        && path
            .strip_prefix(home)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    {
        let mut crumbs = vec![crumb("~", "~")];
        crumbs.extend(segment_crumbs(&path[home.len()..], "~"));
        return crumbs;
    }
    let crumbs = segment_crumbs(path, "");
    if crumbs.is_empty() {
        vec![crumb("/", "/")]
    } else {
        crumbs
    }
}

pub fn short_name(name: &str) -> String {
    let keep = if name.starts_with('.') { 2 } else { 1 };
    name.chars().take(keep).collect()
}

pub fn max_fit_level(crumbs: &[Crumb]) -> i64 {
    i64::try_from(crumbs.len()).unwrap_or(i64::MAX)
}

pub fn fit_crumbs(crumbs: &[Crumb], level: i64) -> Vec<Crumb> {
    let Some((last, leading)) = crumbs.split_last() else {
        return Vec::new();
    };
    if level <= 0 || leading.is_empty() {
        return crumbs.to_vec();
    }
    let short: Vec<Crumb> = leading
        .iter()
        .map(|crumb| Crumb {
            key: crumb.key.clone(),
            label: short_name(&crumb.label),
        })
        .collect();
    let folded = usize::try_from(level - 1).map_or(short.len(), |folds| folds.min(short.len()));
    let mut fitted = Vec::new();
    if folded > 0 {
        fitted.push(crumb(FOLDED_CRUMB, FOLDED_CRUMB));
    }
    fitted.extend_from_slice(&short[folded..]);
    fitted.push(last.clone());
    fitted
}
