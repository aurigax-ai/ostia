use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex, utf16_len};
use regex::Regex;
use serde_json::{Map, Value};

use crate::json_located::{child_index_path, child_path};
use crate::string_enum::StringEnum;
use crate::view_bindings::{
    TemplatePart, ViewFilter, bindings_of, compile_template, has_bindings, is_identifier,
    parse_path,
};
use crate::views::{
    KvPair, NodeKind, ProgressValue, VIEW_ARGS_MAX, VIEW_KV_MAX, VIEW_MAX_DEPTH,
    VIEW_MAX_LIST_ITEMS, VIEW_MAX_NODES, VIEW_NODE_TYPES, VIEW_TEXT_MAX, VIEW_TITLE_MAX,
    VIEW_URL_MAX, ViewAction, ViewButtonVariant, ViewIcon, ViewNode, ViewNodeType, ViewProblem,
    ViewSource, ViewTone, is_http_url, node_keys,
};

const VIEW_PROBLEMS_MAX: usize = 50;

static COMMAND_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"));
static HTTP_PREFIX: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[Hh][Tt][Tt][Pp][Ss]?://"));

pub struct Checker {
    pub problems: Vec<ViewProblem>,
    pub sources: HashSet<ViewSource>,
    pub ticks: bool,
    nodes: usize,
    lines: HashMap<String, usize>,
}

fn with_name(scope: &[String], name: &str) -> Vec<String> {
    let mut inner = scope.to_vec();
    if !scope.iter().any(|known| known == name) {
        inner.push(name.to_owned());
    }
    inner
}

fn is_single_binding(parts: &[TemplatePart]) -> bool {
    parts.len() == 1 && matches!(parts.first(), Some(TemplatePart::Binding(_)))
}

impl Checker {
    pub fn new(lines: HashMap<String, usize>) -> Self {
        Self {
            problems: Vec::new(),
            sources: HashSet::new(),
            ticks: false,
            nodes: 0,
            lines,
        }
    }

    pub fn report(&mut self, path: &str, message: String) {
        if self.problems.len() >= VIEW_PROBLEMS_MAX {
            return;
        }
        let mut probe = path.to_owned();
        let mut line = self.lines.get(&probe).copied();
        while line.is_none() && !probe.is_empty() {
            let cut = probe.rfind(&['.', '['][..]).filter(|index| *index > 0);
            probe = cut.map_or_else(String::new, |index| probe[..index].to_owned());
            line = self.lines.get(&probe).copied();
        }
        let display = if path.is_empty() {
            "(document)".to_owned()
        } else {
            path.to_owned()
        };
        self.problems.push(ViewProblem {
            path: display,
            line,
            message,
        });
    }

    pub fn keys(&mut self, object: &Map<String, Value>, path: &str, allowed: &[&str]) {
        for key in object.keys() {
            if !allowed.contains(&key.as_str()) {
                self.report(
                    &child_path(path, key),
                    format!("unknown property '{key}' (allowed: {})", allowed.join(", ")),
                );
            }
        }
    }

    fn template(
        &mut self,
        value: Option<&Value>,
        path: &str,
        scope: &[String],
        max: usize,
    ) -> String {
        let Some(text) = value.and_then(Value::as_str) else {
            self.report(path, "must be a string".to_owned());
            return String::new();
        };
        if utf16_len(text) > max {
            self.report(path, format!("longer than {max} characters"));
        }
        match compile_template(text) {
            Err(message) => self.report(path, message),
            Ok(_) => {
                for binding in bindings_of(text) {
                    if let Some(name) = binding.path.first() {
                        self.root(name, path, scope);
                    }
                    if binding.filters.contains(&ViewFilter::Relative) {
                        self.ticks = true;
                    }
                }
            }
        }
        text.to_owned()
    }

    fn root(&mut self, name: &str, path: &str, scope: &[String]) {
        if scope.iter().any(|known| known == name) {
            return;
        }
        if let Some(source) = ViewSource::parse(name) {
            self.sources.insert(source);
            if source == ViewSource::Clock {
                self.ticks = true;
            }
            return;
        }
        let names: Vec<&str> = ViewSource::ALL
            .iter()
            .copied()
            .chain(scope.iter().map(String::as_str))
            .collect();
        self.report(
            path,
            format!(
                "unknown data source '{name}' (known here: {})",
                names.join(", ")
            ),
        );
    }

    fn title(&mut self, value: Option<&Value>, path: &str, scope: &[String]) -> String {
        let text = self.template(value, path, scope, VIEW_TITLE_MAX);
        if value
            .and_then(Value::as_str)
            .is_some_and(|raw| js_trim(raw).is_empty())
        {
            self.report(path, "must not be empty".to_owned());
        }
        text
    }

    pub fn one_of<T: StringEnum>(
        &mut self,
        object: &Map<String, Value>,
        key: &str,
        path: &str,
    ) -> Option<T> {
        let value = object.get(key)?;
        match value.as_str().and_then(T::parse) {
            Some(parsed) => Some(parsed),
            None => {
                self.report(
                    &child_path(path, key),
                    format!("must be one of: {}", T::ALL.join(", ")),
                );
                None
            }
        }
    }

    fn flag(&mut self, object: &Map<String, Value>, key: &str, path: &str) -> Option<bool> {
        let value = object.get(key)?;
        match value.as_bool() {
            Some(flag) => Some(flag),
            None => {
                self.report(&child_path(path, key), "must be true or false".to_owned());
                None
            }
        }
    }

    fn url(&mut self, value: Option<&Value>, path: &str, scope: &[String]) -> String {
        let url = self.template(value, path, scope, VIEW_URL_MAX);
        if value.and_then(Value::as_str).is_none() {
            return url;
        }
        let Ok(parts) = compile_template(&url) else {
            return url;
        };
        if !has_bindings(&url) {
            if !is_http_url(&url) {
                self.report(path, "must be an http:// or https:// URL".to_owned());
            }
            return url;
        }
        if !is_single_binding(&parts) && !HTTP_PREFIX.is_match(&url) {
            self.report(
                path,
                "must start with 'http://' or 'https://', or be a single {{binding}}".to_owned(),
            );
        }
        url
    }

    fn args(&mut self, value: &Value, path: &str, scope: &[String]) {
        match value {
            Value::String(_) => {
                self.template(Some(value), path, scope, VIEW_TEXT_MAX);
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    self.args(item, &child_index_path(path, index), scope);
                }
            }
            Value::Object(object) => {
                for (key, item) in object {
                    self.args(item, &child_path(path, key), scope);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }

    fn action(
        &mut self,
        value: Option<&Value>,
        path: &str,
        scope: &[String],
    ) -> Option<ViewAction> {
        let Some(object) = value.and_then(Value::as_object) else {
            self.report(
                path,
                "must be an object with \"command\" (and optional \"args\") or \"openUrl\""
                    .to_owned(),
            );
            return None;
        };
        if object.contains_key("openUrl") {
            self.keys(object, path, &["openUrl"]);
            let url = self.url(object.get("openUrl"), &child_path(path, "openUrl"), scope);
            return Some(ViewAction::OpenUrl(url));
        }
        self.keys(object, path, &["command", "args"]);
        let Some(command) = object
            .get("command")
            .and_then(Value::as_str)
            .filter(|command| COMMAND_ID.is_match(command))
        else {
            self.report(
                &child_path(path, "command"),
                "must be a palette command id, e.g. \"workspace.new\"".to_owned(),
            );
            return None;
        };
        let command = command.to_owned();
        let Some(args_value) = object.get("args") else {
            return Some(ViewAction::Command {
                command,
                args: None,
            });
        };
        let args_path = child_path(path, "args");
        let Some(args) = args_value.as_object() else {
            self.report(&args_path, "must be an object".to_owned());
            return None;
        };
        let serialized = serde_json::to_string(args_value).unwrap_or_default();
        if utf16_len(&serialized) > VIEW_ARGS_MAX {
            self.report(
                &args_path,
                format!("larger than {VIEW_ARGS_MAX} characters of JSON"),
            );
        }
        self.args(args_value, &args_path, scope);
        Some(ViewAction::Command {
            command,
            args: Some(args.clone()),
        })
    }

    fn children(
        &mut self,
        value: Option<&Value>,
        path: &str,
        depth: usize,
        scope: &[String],
    ) -> Vec<ViewNode> {
        let Some(items) = value.and_then(Value::as_array) else {
            self.report(path, "must be an array of nodes".to_owned());
            return Vec::new();
        };
        let mut out = Vec::new();
        for (index, child) in items.iter().enumerate() {
            let child_at = child_index_path(path, index);
            if let Some(node) = self.node(Some(child), &child_at, depth, scope) {
                out.push(node);
            }
        }
        out
    }

    pub fn node(
        &mut self,
        value: Option<&Value>,
        path: &str,
        depth: usize,
        scope: &[String],
    ) -> Option<ViewNode> {
        let Some(object) = value.and_then(Value::as_object) else {
            self.report(path, "must be a node object with a \"type\"".to_owned());
            return None;
        };
        self.nodes += 1;
        if self.nodes == VIEW_MAX_NODES + 1 {
            self.report(
                path,
                format!("more than {VIEW_MAX_NODES} nodes in one view"),
            );
        }
        if depth > VIEW_MAX_DEPTH {
            self.report(path, format!("nested deeper than {VIEW_MAX_DEPTH} levels"));
            return None;
        }
        let Some(node_type) = object
            .get("type")
            .and_then(Value::as_str)
            .and_then(ViewNodeType::parse)
        else {
            self.report(
                &child_path(path, "type"),
                format!("must be one of: {}", VIEW_NODE_TYPES.join(", ")),
            );
            return None;
        };
        let mut allowed = vec!["type", "if"];
        allowed.extend_from_slice(node_keys(node_type));
        self.keys(object, path, &allowed);

        let condition = object.get("if").map(|raw| {
            let if_path = child_path(path, "if");
            let template = self.template(Some(raw), &if_path, scope, VIEW_TEXT_MAX);
            if compile_template(&template).is_ok_and(|parts| !is_single_binding(&parts)) {
                self.report(&if_path, "must be a single {{binding}}".to_owned());
            }
            template
        });

        let kind = match node_type {
            ViewNodeType::Stack => NodeKind::Stack {
                children: self.children(
                    object.get("children"),
                    &child_path(path, "children"),
                    depth + 1,
                    scope,
                ),
                gap: self.one_of(object, "gap", path),
            },
            ViewNodeType::Row => NodeKind::Row {
                children: self.children(
                    object.get("children"),
                    &child_path(path, "children"),
                    depth + 1,
                    scope,
                ),
                gap: self.one_of(object, "gap", path),
                justify: self.one_of(object, "justify", path),
                wrap: self.flag(object, "wrap", path),
            },
            ViewNodeType::Section => NodeKind::Section {
                title: self.title(object.get("title"), &child_path(path, "title"), scope),
                children: self.children(
                    object.get("children"),
                    &child_path(path, "children"),
                    depth + 1,
                    scope,
                ),
                collapsed: self.flag(object, "collapsed", path),
            },
            ViewNodeType::Text => NodeKind::Text {
                text: self.template(
                    object.get("text"),
                    &child_path(path, "text"),
                    scope,
                    VIEW_TEXT_MAX,
                ),
                tone: self.one_of(object, "tone", path),
                size: self.one_of(object, "size", path),
                weight: self.one_of(object, "weight", path),
                mono: self.flag(object, "mono", path),
                truncate: self.flag(object, "truncate", path),
            },
            ViewNodeType::Badge => NodeKind::Badge {
                text: self.template(
                    object.get("text"),
                    &child_path(path, "text"),
                    scope,
                    VIEW_TITLE_MAX,
                ),
                tone: self.one_of(object, "tone", path),
            },
            ViewNodeType::Icon => {
                let name = self.one_of::<ViewIcon>(object, "name", path);
                if object.get("name").is_none() {
                    self.report(&child_path(path, "name"), "is required".to_owned());
                }
                NodeKind::Icon {
                    name: name.unwrap_or(ViewIcon::Circle),
                    tone: self.one_of(object, "tone", path),
                    label: object.get("label").map(|raw| {
                        self.template(Some(raw), &child_path(path, "label"), scope, VIEW_TITLE_MAX)
                    }),
                }
            }
            ViewNodeType::List => self.list(object, path, depth, scope),
            ViewNodeType::Button => NodeKind::Button {
                label: self.title(object.get("label"), &child_path(path, "label"), scope),
                icon: self.one_of(object, "icon", path),
                variant: self.one_of::<ViewButtonVariant>(object, "variant", path),
                action: self
                    .action(object.get("action"), &child_path(path, "action"), scope)
                    .unwrap_or(ViewAction::Command {
                        command: "invalid".to_owned(),
                        args: None,
                    }),
            },
            ViewNodeType::Link => NodeKind::Link {
                label: self.title(object.get("label"), &child_path(path, "label"), scope),
                url: self.url(object.get("url"), &child_path(path, "url"), scope),
            },
            ViewNodeType::Progress => self.progress(object, path, scope),
            ViewNodeType::Kv => NodeKind::Kv {
                items: self.kv(object.get("items"), &child_path(path, "items"), scope),
            },
            ViewNodeType::Divider => NodeKind::Divider,
        };
        Some(ViewNode { condition, kind })
    }

    fn list(
        &mut self,
        object: &Map<String, Value>,
        path: &str,
        depth: usize,
        scope: &[String],
    ) -> NodeKind {
        let for_path = child_path(path, "for");
        let mut source = String::new();
        match object.get("for").and_then(Value::as_str) {
            Some(data_path) => {
                match parse_path(data_path) {
                    Err(message) => self.report(&for_path, message),
                    Ok(segments) => {
                        if let Some(name) = segments.first() {
                            self.root(name, &for_path, scope);
                        }
                    }
                }
                source = data_path.to_owned();
            }
            None => self.report(
                &for_path,
                "must be a data path such as \"workspaces\" or \"workspace.ports\"".to_owned(),
            ),
        }

        let as_path = child_path(path, "as");
        let mut as_name = "item".to_owned();
        if let Some(raw) = object.get("as") {
            match raw.as_str() {
                Some(name) if is_identifier(name) => {
                    if ViewSource::parse(name).is_some() || scope.iter().any(|known| known == name)
                    {
                        self.report(
                            &as_path,
                            format!("'{name}' is already a data source or an outer list's name"),
                        );
                    } else {
                        as_name = name.to_owned();
                    }
                }
                _ => self.report(&as_path, "must be a simple name such as \"ws\"".to_owned()),
            }
        }

        let mut limit = None;
        if let Some(raw) = object.get("limit") {
            match raw.as_f64() {
                Some(whole)
                    if whole.fract() == 0.0
                        && whole >= 1.0
                        && whole <= VIEW_MAX_LIST_ITEMS as f64 =>
                {
                    limit = Some(whole as usize);
                }
                _ => self.report(
                    &child_path(path, "limit"),
                    format!("must be a whole number from 1 to {VIEW_MAX_LIST_ITEMS}"),
                ),
            }
        }

        let inner = with_name(scope, &as_name);
        let item = self
            .node(
                object.get("item"),
                &child_path(path, "item"),
                depth + 1,
                &inner,
            )
            .unwrap_or(ViewNode {
                condition: None,
                kind: NodeKind::Divider,
            });
        let empty = object
            .get("empty")
            .map(|raw| self.template(Some(raw), &child_path(path, "empty"), scope, VIEW_TITLE_MAX));
        let gap = self.one_of(object, "gap", path);
        NodeKind::List {
            source,
            as_name,
            limit,
            item: Box::new(item),
            empty,
            gap,
        }
    }

    fn progress(&mut self, object: &Map<String, Value>, path: &str, scope: &[String]) -> NodeKind {
        let value_path = child_path(path, "value");
        let raw = object.get("value");
        let amount = match (raw.and_then(Value::as_f64), raw.and_then(Value::as_str)) {
            (Some(number), _) => ProgressValue::Fixed(number),
            (None, Some(_)) => {
                let template = self.template(raw, &value_path, scope, VIEW_TEXT_MAX);
                if compile_template(&template).is_ok_and(|parts| !is_single_binding(&parts)) {
                    self.report(
                        &value_path,
                        "must be a number or a single {{binding}}".to_owned(),
                    );
                }
                ProgressValue::Template(template)
            }
            (None, None) => {
                self.report(
                    &value_path,
                    "must be a number or a single {{binding}}".to_owned(),
                );
                ProgressValue::Fixed(0.0)
            }
        };

        let max = match object.get("max") {
            None => None,
            Some(raw_max) => match raw_max.as_f64().filter(|max| *max > 0.0) {
                Some(max) => Some(max),
                None => {
                    self.report(
                        &child_path(path, "max"),
                        "must be a number above 0".to_owned(),
                    );
                    None
                }
            },
        };
        let label = object.get("label").map(|raw_label| {
            self.template(
                Some(raw_label),
                &child_path(path, "label"),
                scope,
                VIEW_TITLE_MAX,
            )
        });
        let tone: Option<ViewTone> = self.one_of(object, "tone", path);
        NodeKind::Progress {
            value: amount,
            max,
            label,
            tone,
        }
    }

    fn kv(&mut self, value: Option<&Value>, path: &str, scope: &[String]) -> Vec<KvPair> {
        let Some(pairs) = value.and_then(Value::as_array) else {
            self.report(
                path,
                "must be an array of {\"key\", \"value\"} pairs".to_owned(),
            );
            return Vec::new();
        };
        if pairs.len() > VIEW_KV_MAX {
            self.report(path, format!("more than {VIEW_KV_MAX} pairs"));
        }
        let mut out = Vec::new();
        for (index, pair) in pairs.iter().take(VIEW_KV_MAX).enumerate() {
            let pair_path = child_index_path(path, index);
            let Some(object) = pair.as_object() else {
                self.report(
                    &pair_path,
                    "must be an object with \"key\" and \"value\"".to_owned(),
                );
                continue;
            };
            self.keys(object, &pair_path, &["key", "value"]);
            let key = self.template(
                object.get("key"),
                &child_path(&pair_path, "key"),
                scope,
                VIEW_TITLE_MAX,
            );
            let text = self.template(
                object.get("value"),
                &child_path(&pair_path, "value"),
                scope,
                VIEW_TEXT_MAX,
            );
            out.push(KvPair { key, value: text });
        }
        out
    }
}
