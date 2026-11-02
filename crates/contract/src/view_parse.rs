use std::collections::HashMap;

use ostia_base::js::{js_trim, utf16_len};
use serde_json::Value;

use crate::json_located::parse_located_json;
use crate::string_enum::StringEnum;
use crate::view_checker::Checker;
use crate::views::{
    VIEW_DESCRIPTION_MAX, VIEW_TITLE_MAX, VIEW_VERSION, ViewDoc, ViewIcon, ViewPlacement,
    ViewProblem, ViewSource,
};

const DOC_KEYS: [&str; 7] = [
    "$schema",
    "version",
    "title",
    "placement",
    "icon",
    "description",
    "root",
];

#[derive(Debug, Clone, PartialEq)]
pub enum ViewParseResult {
    Ok(Box<ViewDoc>),
    Failed(Vec<ViewProblem>),
}

fn parse_view_value(raw: &Value, lines: HashMap<String, usize>) -> ViewParseResult {
    let mut checker = Checker::new(lines);
    let Some(object) = raw.as_object() else {
        checker.report("", "a view file must be a JSON object".to_owned());
        return ViewParseResult::Failed(checker.problems);
    };
    checker.keys(object, "", &DOC_KEYS);
    if object
        .get("$schema")
        .is_some_and(|schema| !schema.is_string())
    {
        checker.report("$schema", "must be a string".to_owned());
    }
    if object.get("version").and_then(Value::as_f64) != Some(f64::from(VIEW_VERSION)) {
        checker.report("version", format!("must be {VIEW_VERSION}"));
    }
    let mut title = String::new();
    match object.get("title").and_then(Value::as_str) {
        Some(text) if !js_trim(text).is_empty() => {
            if utf16_len(text) > VIEW_TITLE_MAX {
                checker.report("title", format!("longer than {VIEW_TITLE_MAX} characters"));
            } else {
                title = text.to_owned();
            }
        }
        _ => checker.report("title", "is required".to_owned()),
    }
    let placement: Option<ViewPlacement> = checker.one_of(object, "placement", "");
    if object.get("placement").is_none() {
        checker.report("placement", "is required (sidebar or panel)".to_owned());
    }
    let icon: Option<ViewIcon> = checker.one_of(object, "icon", "");
    let mut description = None;
    if let Some(raw_description) = object.get("description") {
        match raw_description.as_str() {
            Some(text) if utf16_len(text) <= VIEW_DESCRIPTION_MAX => {
                if !text.is_empty() {
                    description = Some(text.to_owned());
                }
            }
            _ => checker.report(
                "description",
                format!("must be a string of at most {VIEW_DESCRIPTION_MAX} characters"),
            ),
        }
    }
    let root = match object.get("root") {
        Some(raw_root) => checker.node(Some(raw_root), "root", 1, &[]),
        None => {
            checker.report("root", "is required".to_owned());
            None
        }
    };
    let (Some(root), Some(placement)) = (root, placement) else {
        return ViewParseResult::Failed(checker.problems);
    };
    if !checker.problems.is_empty() {
        return ViewParseResult::Failed(checker.problems);
    }
    let sources = ViewSource::ALL
        .iter()
        .filter_map(|name| ViewSource::parse(name))
        .filter(|source| checker.sources.contains(source))
        .collect();
    ViewParseResult::Ok(Box::new(ViewDoc {
        title,
        placement,
        icon,
        description,
        root,
        sources,
        ticks: checker.ticks,
    }))
}

pub fn parse_view_text(text: &str) -> ViewParseResult {
    match parse_located_json(text) {
        Err(error) => ViewParseResult::Failed(vec![ViewProblem {
            path: "(document)".to_owned(),
            line: Some(error.line),
            message: format!("invalid JSON at column {}: {}", error.column, error.message),
        }]),
        Ok(located) => parse_view_value(&located.value, located.lines),
    }
}
