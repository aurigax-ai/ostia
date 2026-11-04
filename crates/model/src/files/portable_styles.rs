use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex};
use regex::Regex;

static VARIABLE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"var\([{JS_SPACE_CLASS}]*(--[A-Za-z0-9_-]+)")));

fn variables_in(text: &str) -> impl Iterator<Item = String> + '_ {
    VARIABLE
        .captures_iter(text)
        .filter_map(|found| found.get(1).map(|name| name.as_str().to_owned()))
}

pub fn with_root_variables(css: &str, value_of: impl Fn(&str) -> String) -> String {
    let mut names: Vec<String> = Vec::new();
    let mut pending: Vec<String> = variables_in(css).collect();
    while let Some(name) = pending.pop() {
        if names.contains(&name) {
            continue;
        }
        pending.extend(variables_in(&value_of(&name)));
        names.push(name);
    }
    let values: Vec<String> = names
        .iter()
        .filter_map(|name| {
            let value = value_of(name);
            let value = js_trim(&value);
            (!value.is_empty()).then(|| format!("{name}:{value}"))
        })
        .collect();
    if values.is_empty() {
        css.to_owned()
    } else {
        format!(":root{{{}}}\n{css}", values.join(";"))
    }
}
