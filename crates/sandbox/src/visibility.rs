use std::path::Path;

use ostia_base::js::utf16_len;
use ostia_base::path_guard::is_inside_path;

const PATH_DELIMITER: char = ':';

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SandboxReadRules {
    pub deny_read: Vec<String>,
    pub allow_read: Vec<String>,
}

fn deepest(path: &str, dirs: &[String]) -> Option<usize> {
    dirs.iter()
        .filter(|dir| is_inside_path(Path::new(dir.as_str()), Path::new(path)))
        .map(|dir| utf16_len(dir))
        .max()
}

pub fn visible_in_sandbox(path: &str, rules: &SandboxReadRules) -> bool {
    if !path.starts_with('/') {
        return false;
    }
    match deepest(path, &rules.deny_read) {
        None => true,
        Some(denied) => deepest(path, &rules.allow_read).is_some_and(|allowed| allowed > denied),
    }
}

pub fn leads_into_sandbox(path: &str, rules: &SandboxReadRules) -> bool {
    rules.allow_read.iter().any(|allowed| {
        is_inside_path(Path::new(path), Path::new(allowed.as_str()))
            && visible_in_sandbox(allowed, rules)
    })
}

pub fn sandbox_path(path: &str, rules: &SandboxReadRules) -> String {
    path.split(PATH_DELIMITER)
        .filter(|dir| !dir.is_empty() && visible_in_sandbox(dir, rules))
        .collect::<Vec<_>>()
        .join(&PATH_DELIMITER.to_string())
}

pub fn sandbox_entries<T: Clone>(
    dir: &str,
    entries: &[T],
    rules: &SandboxReadRules,
    name_of: impl Fn(&T) -> &str,
) -> Vec<T> {
    let base = if dir.ends_with('/') {
        dir.to_owned()
    } else {
        format!("{dir}/")
    };
    entries
        .iter()
        .filter(|entry| {
            let path = format!("{base}{}", name_of(entry));
            visible_in_sandbox(&path, rules) || leads_into_sandbox(&path, rules)
        })
        .cloned()
        .collect()
}
