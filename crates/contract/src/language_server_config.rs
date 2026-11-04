use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::language_servers::{EXTENSION_DIR_PLACEHOLDER, ROOT_PLACEHOLDER};
use ostia_base::js::utf16_len;

pub fn substitute_placeholders(text: &str, extension_dir: &str, root: &str) -> String {
    text.replace(EXTENSION_DIR_PLACEHOLDER, extension_dir)
        .replace(ROOT_PLACEHOLDER, root)
}

pub fn substitute_json(value: &Value, extension_dir: &str, root: &str) -> Value {
    match value {
        Value::String(text) => Value::String(substitute_placeholders(text, extension_dir, root)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| substitute_json(item, extension_dir, root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), substitute_json(item, extension_dir, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn set_path(node: &mut Map<String, Value>, segments: &[&str], value: Value) {
    let Some((last, parents)) = segments.split_last() else {
        return;
    };
    let mut node = node;
    for segment in parents {
        if !node.get(*segment).is_some_and(Value::is_object) {
            node.insert((*segment).to_owned(), Value::Object(Map::new()));
        }
        let Some(Value::Object(next)) = node.get_mut(*segment) else {
            return;
        };
        node = next;
    }
    node.insert((*last).to_owned(), value);
}

pub fn overlay_settings(
    base: &Value,
    paths: &Map<String, Value>,
    values: &Map<String, Value>,
) -> Value {
    let mut out = base.clone();
    let Some(root) = out.as_object_mut() else {
        return out;
    };
    for (key, path) in paths {
        let (Some(value), Some(path)) = (values.get(key), path.as_str()) else {
            continue;
        };
        let segments: Vec<&str> = path.split('.').collect();
        set_path(root, &segments, value.clone());
    }
    out
}

pub fn configuration_section<'a>(settings: &'a Value, section: Option<&str>) -> Option<&'a Value> {
    let Some(section) = section.filter(|section| !section.is_empty()) else {
        return Some(settings);
    };
    let mut node = settings;
    for segment in section.split('.') {
        node = node.as_object()?.get(segment)?;
    }
    Some(node)
}

pub fn document_language_id(
    ids: Option<&HashMap<String, String>>,
    path: &str,
    language: &str,
) -> String {
    let Some(ids) = ids else {
        return language.to_owned();
    };
    let name = path
        .rsplit_once('/')
        .map_or(path, |(_, name)| name)
        .to_lowercase();
    let best = ids
        .keys()
        .filter(|key| key.starts_with('.') && name.ends_with(&key.to_lowercase()))
        .max_by(|left, right| {
            utf16_len(left)
                .cmp(&utf16_len(right))
                .then_with(|| right.cmp(left))
        });
    match best {
        Some(key) => ids[key].clone(),
        None => ids
            .get(language)
            .map_or_else(|| language.to_owned(), Clone::clone),
    }
}
