use ostia_base::js::js_trim;

pub const PDF_MAX_PAGES: usize = 300;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextItem {
    pub text: Option<String>,
    pub has_eol: bool,
}

pub fn item_lines(items: &[TextItem]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for item in items {
        if let Some(text) = &item.text {
            line.push_str(text);
        }
        if item.has_eol {
            lines.push(std::mem::take(&mut line));
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
        .iter()
        .map(|l| js_trim(l))
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}
