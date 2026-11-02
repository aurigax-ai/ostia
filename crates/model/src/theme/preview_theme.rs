use std::collections::BTreeMap;

use ostia_base::js::js_trim;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewTheme {
    pub dark: bool,
    pub vars: BTreeMap<String, String>,
}

const TOKENS: [(&str, &str); 8] = [
    ("--ostia-bg", "--surface-1"),
    ("--ostia-surface", "--surface-2"),
    ("--ostia-fg", "--fg"),
    ("--ostia-muted", "--fg-muted"),
    ("--ostia-line", "--line"),
    ("--ostia-accent", "--brand"),
    ("--ostia-font", "--font-ui"),
    ("--ostia-font-mono", "--font-code"),
];

pub fn preview_theme(dark: bool, computed: impl Fn(&str) -> Option<String>) -> PreviewTheme {
    let vars = TOKENS
        .iter()
        .filter_map(|(name, token)| {
            let value = computed(token)?;
            let value = js_trim(&value);
            (!value.is_empty()).then(|| ((*name).to_owned(), value.to_owned()))
        })
        .collect();
    PreviewTheme { dark, vars }
}
