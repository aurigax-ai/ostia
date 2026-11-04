use ostia_base::js::{js_to_number, js_trim};
use ostia_contract::file_links::find_file_links;
use serde_json::{Map, Value, json};
use url::Url;

use crate::prompt::utf16_text::{from_units, slice, units};

const SKIP_TAGS: [&str; 3] = ["a", "code", "pre"];

const FILE_LINK_PATH: &str = "data-ostia-path";
const FILE_LINK_LINE: &str = "data-ostia-line";
const FILE_LINK_COLUMN: &str = "data-ostia-column";

#[derive(Clone, Debug, PartialEq)]
pub struct FileLinkTarget {
    pub path: String,
    pub line: Option<f64>,
    pub column: Option<f64>,
}

fn text_node(value: String) -> Value {
    json!({ "type": "text", "value": value })
}

fn link_element(text: String, path: &str, line: Option<u64>, column: Option<u64>) -> Value {
    let mut properties = Map::new();
    properties.insert("dataOstiaPath".to_owned(), Value::from(path));
    if let Some(line) = line.filter(|line| *line > 0) {
        properties.insert("dataOstiaLine".to_owned(), Value::from(line.to_string()));
    }
    if let Some(column) = column.filter(|column| *column > 0) {
        properties.insert(
            "dataOstiaColumn".to_owned(),
            Value::from(column.to_string()),
        );
    }
    json!({
        "type": "element",
        "tagName": "a",
        "properties": properties,
        "children": [text_node(text)],
    })
}

fn split_text(value: &str) -> Option<Vec<Value>> {
    let matches = find_file_links(value);
    if matches.is_empty() {
        return None;
    }
    let all = units(value);
    let mut out = Vec::new();
    let mut at = 0;
    for found in matches {
        if found.start > at {
            out.push(text_node(from_units(slice(&all, at, found.start))));
        }
        out.push(link_element(
            from_units(slice(&all, found.start, found.end)),
            &found.path,
            found.line,
            found.column,
        ));
        at = found.end;
    }
    if at < all.len() {
        out.push(text_node(from_units(slice(&all, at, all.len()))));
    }
    Some(out)
}

fn walk(node: &mut Value) {
    let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) else {
        return;
    };
    let mut next = Vec::with_capacity(children.len());
    for mut child in std::mem::take(children) {
        if child["type"] == "text"
            && let Some(parts) = child["value"].as_str().and_then(split_text)
        {
            next.extend(parts);
            continue;
        }
        let is_text = child["type"] == "text" && child["value"].is_string();
        let skipped = child["type"] == "element"
            && child["tagName"]
                .as_str()
                .is_some_and(|tag| SKIP_TAGS.contains(&tag));
        if !is_text && !skipped {
            walk(&mut child);
        }
        next.push(child);
    }
    *children = next;
}

pub fn rehype_file_links(tree: &mut Value) {
    walk(tree);
}

fn positive(value: Option<&Value>) -> Option<f64> {
    let number = value.map_or(f64::NAN, js_to_number);
    (number > 0.0).then_some(number)
}

pub fn file_link_of(props: &Map<String, Value>) -> Option<FileLinkTarget> {
    let path = props
        .get(FILE_LINK_PATH)
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())?;
    Some(FileLinkTarget {
        path: path.to_owned(),
        line: positive(props.get(FILE_LINK_LINE)),
        column: positive(props.get(FILE_LINK_COLUMN)),
    })
}

pub fn whole_file_link(text: &str) -> Option<FileLinkTarget> {
    let trimmed = js_trim(text);
    let length = trimmed.encode_utf16().count();
    let found = find_file_links(trimmed)
        .into_iter()
        .find(|m| m.start == 0 && m.end == length)?;
    Some(FileLinkTarget {
        path: found.path,
        line: found.line.filter(|line| *line > 0).map(|line| line as f64),
        column: found
            .column
            .filter(|column| *column > 0)
            .map(|column| column as f64),
    })
}

pub fn is_web_url(href: &str) -> bool {
    Url::parse(href).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}
