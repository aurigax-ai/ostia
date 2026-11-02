const MAX_LISTED: usize = 12;

pub fn listed_paths(paths: &[String], discard_more: &str) -> String {
    let shown = paths
        .iter()
        .take(MAX_LISTED)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    if paths.len() <= MAX_LISTED {
        return shown;
    }
    let hidden = (paths.len() - MAX_LISTED).to_string();
    format!("{shown}\n{}", discard_more.replacen("{count}", &hidden, 1))
}
