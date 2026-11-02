use ostia_base::PRODUCT_NAME;
use serde_json::{Map, Value, json};

use crate::string_enum::StringEnum;
use crate::view_bindings::VIEW_FILTERS;
use crate::views::{
    VIEW_ARGS_MAX, VIEW_DESCRIPTION_MAX, VIEW_KV_MAX, VIEW_MAX_DEPTH, VIEW_MAX_LIST_ITEMS,
    VIEW_MAX_NODES, VIEW_MAX_RENDERED_NODES, VIEW_TEXT_MAX, VIEW_TITLE_MAX, VIEW_VERSION,
    ViewButtonVariant, ViewGap, ViewIcon, ViewIconTone, ViewJustify, ViewPlacement, ViewSource,
    ViewTextSize, ViewTone, ViewWeight,
};

const BINDING_PATTERN: &str = "^\\{\\{[^{}]+\\}\\}$";

fn text(max_length: usize) -> Value {
    json!({
        "type": "string",
        "maxLength": max_length,
        "description": "Text with optional {{path | filter}} bindings",
    })
}

fn one_of<T: StringEnum>() -> Value {
    json!({ "type": "string", "enum": T::ALL })
}

fn binding() -> Value {
    json!({ "type": "string", "pattern": BINDING_PATTERN })
}

fn children() -> Value {
    json!({ "type": "array", "items": { "$ref": "#/$defs/node" } })
}

fn node(kind: &str, properties: Value, required: &[&str]) -> Value {
    let mut all = Map::new();
    all.insert("type".to_owned(), json!({ "const": kind }));
    all.insert(
        "if".to_owned(),
        json!({
            "type": "string",
            "pattern": BINDING_PATTERN,
            "description": "Render only when this binding is truthy",
        }),
    );
    if let Value::Object(extra) = properties {
        all.extend(extra);
    }
    let mut needed = vec!["type"];
    needed.extend_from_slice(required);
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": needed,
        "properties": all,
    })
}

fn action() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["command"],
                "properties": {
                    "command": { "type": "string", "description": "A palette command id (ostia commands)" },
                    "args": {
                        "type": "object",
                        "description": format!("Command arguments; strings may hold bindings. At most {VIEW_ARGS_MAX} characters of JSON"),
                    },
                },
            },
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["openUrl"],
                "properties": { "openUrl": { "type": "string", "description": "http(s) URL" } },
            },
        ],
    })
}

fn node_defs() -> Value {
    json!({
        "oneOf": [
            node("stack", json!({ "children": children(), "gap": one_of::<ViewGap>() }), &["children"]),
            node(
                "row",
                json!({
                    "children": children(),
                    "gap": one_of::<ViewGap>(),
                    "justify": one_of::<ViewJustify>(),
                    "wrap": { "type": "boolean" },
                }),
                &["children"],
            ),
            node(
                "section",
                json!({
                    "title": text(VIEW_TITLE_MAX),
                    "children": children(),
                    "collapsed": { "type": "boolean" },
                }),
                &["title", "children"],
            ),
            node(
                "text",
                json!({
                    "text": text(VIEW_TEXT_MAX),
                    "tone": one_of::<ViewTone>(),
                    "size": one_of::<ViewTextSize>(),
                    "weight": one_of::<ViewWeight>(),
                    "mono": { "type": "boolean" },
                    "truncate": { "type": "boolean" },
                }),
                &["text"],
            ),
            node(
                "badge",
                json!({ "text": text(VIEW_TITLE_MAX), "tone": one_of::<ViewTone>() }),
                &["text"],
            ),
            node(
                "icon",
                json!({
                    "name": one_of::<ViewIcon>(),
                    "tone": one_of::<ViewIconTone>(),
                    "label": text(VIEW_TITLE_MAX),
                }),
                &["name"],
            ),
            node(
                "list",
                json!({
                    "for": { "type": "string", "description": "Data path, e.g. \"workspaces\"" },
                    "as": { "type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$", "default": "item" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": VIEW_MAX_LIST_ITEMS },
                    "item": { "$ref": "#/$defs/node" },
                    "empty": text(VIEW_TITLE_MAX),
                    "gap": one_of::<ViewGap>(),
                }),
                &["for", "item"],
            ),
            node(
                "button",
                json!({
                    "label": text(VIEW_TITLE_MAX),
                    "icon": one_of::<ViewIcon>(),
                    "variant": one_of::<ViewButtonVariant>(),
                    "action": { "$ref": "#/$defs/action" },
                }),
                &["label", "action"],
            ),
            node(
                "link",
                json!({ "label": text(VIEW_TITLE_MAX), "url": { "type": "string" } }),
                &["label", "url"],
            ),
            node(
                "progress",
                json!({
                    "value": { "oneOf": [{ "type": "number" }, binding()] },
                    "max": { "type": "number", "exclusiveMinimum": 0, "default": 100 },
                    "label": text(VIEW_TITLE_MAX),
                    "tone": one_of::<ViewTone>(),
                }),
                &["value"],
            ),
            node(
                "kv",
                json!({
                    "items": {
                        "type": "array",
                        "maxItems": VIEW_KV_MAX,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["key", "value"],
                            "properties": { "key": text(VIEW_TITLE_MAX), "value": text(VIEW_TEXT_MAX) },
                        },
                    },
                }),
                &["items"],
            ),
            node("divider", json!({}), &[]),
        ],
    })
}

pub fn view_json_schema() -> Value {
    let description = [
        format!(
            "A data-only view in ~/.config/{PRODUCT_NAME}/views/<name>.json. Budget: {VIEW_MAX_NODES} nodes,"
        ),
        format!(
            "{VIEW_MAX_DEPTH} levels, {VIEW_MAX_LIST_ITEMS} items per list, {VIEW_MAX_RENDERED_NODES}"
        ),
        format!(
            "rendered nodes. Data sources: {}. Filters: {}.",
            ViewSource::ALL.join(", "),
            VIEW_FILTERS.join(", ")
        ),
    ]
    .join(" ");
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": format!("{PRODUCT_NAME} view"),
        "description": description,
        "type": "object",
        "additionalProperties": false,
        "required": ["version", "title", "placement", "root"],
        "properties": {
            "$schema": { "type": "string" },
            "version": { "const": VIEW_VERSION },
            "title": { "type": "string", "minLength": 1, "maxLength": VIEW_TITLE_MAX },
            "placement": one_of::<ViewPlacement>(),
            "icon": one_of::<ViewIcon>(),
            "description": { "type": "string", "maxLength": VIEW_DESCRIPTION_MAX },
            "root": { "$ref": "#/$defs/node" },
        },
        "$defs": {
            "action": action(),
            "node": node_defs(),
        },
    })
}
