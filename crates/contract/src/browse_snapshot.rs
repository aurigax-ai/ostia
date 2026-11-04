use ostia_base::js::{js_number_text, non_empty};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MixedTag {
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Checked {
    Flag(bool),
    Mixed(MixedTag),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SnapshotNode {
    pub role: String,
    pub name: String,
    #[serde(rename = "ref", default)]
    pub node_ref: Option<String>,
    #[serde(default)]
    pub interactive: Option<bool>,
    #[serde(default)]
    pub level: Option<f64>,
    #[serde(default)]
    pub checked: Option<Checked>,
    #[serde(default)]
    pub disabled: Option<bool>,
    #[serde(default)]
    pub expanded: Option<bool>,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    pub children: Vec<SnapshotNode>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct SnapshotOptions {
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub depth: Option<f64>,
    #[serde(default)]
    pub urls: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormattedSnapshot {
    pub snapshot: String,
    pub refs: Map<String, Value>,
}

const TEXT_ROLE: &str = "text";

fn is_interactive(node: &SnapshotNode) -> bool {
    node.interactive.unwrap_or(false)
}

fn is_structural(node: &SnapshotNode) -> bool {
    node.role != TEXT_ROLE && !is_interactive(node) && node.name.is_empty()
}

fn keep_in_compact(node: &SnapshotNode) -> bool {
    if node.role == TEXT_ROLE {
        return !node.name.is_empty();
    }
    if is_interactive(node) || !node.name.is_empty() {
        return true;
    }
    !node.children.is_empty()
}

fn filter_interactive(nodes: &[SnapshotNode]) -> Vec<SnapshotNode> {
    let mut out = Vec::new();
    for node in nodes {
        let children = filter_interactive(&node.children);
        if is_interactive(node) {
            out.push(SnapshotNode {
                children,
                ..node.clone()
            });
        } else {
            out.extend(children);
        }
    }
    out
}

fn compact_nodes(nodes: Vec<SnapshotNode>) -> Vec<SnapshotNode> {
    let mut out = Vec::new();
    for mut node in nodes {
        node.children = compact_nodes(std::mem::take(&mut node.children));
        if !keep_in_compact(&node) {
            continue;
        }
        if is_structural(&node) && node.children.len() == 1 {
            out.extend(node.children);
            continue;
        }
        out.push(node);
    }
    out
}

fn attrs_of(node: &SnapshotNode) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(node_ref) = non_empty(node.node_ref.as_deref()) {
        parts.push(format!("[ref={node_ref}]"));
    }
    if let Some(level) = node.level {
        parts.push(format!("[level={}]", js_number_text(level)));
    }
    match node.checked {
        Some(Checked::Mixed(_)) => parts.push("[checked=mixed]".to_owned()),
        Some(Checked::Flag(true)) => parts.push("[checked]".to_owned()),
        _ => {}
    }
    if node.disabled == Some(true) {
        parts.push("[disabled]".to_owned());
    }
    if let Some(expanded) = node.expanded {
        parts.push(format!("[expanded={expanded}]"));
    }
    if node.selected == Some(true) {
        parts.push("[selected]".to_owned());
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    }
}

fn quoted(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

fn line_for(node: &SnapshotNode) -> String {
    if node.role == TEXT_ROLE {
        return format!("- text: {}", node.name);
    }
    let name = if node.name.is_empty() {
        String::new()
    } else {
        format!(" {}", quoted(&node.name))
    };
    let value = non_empty(node.value.as_deref())
        .map(|value| format!(": {value}"))
        .unwrap_or_default();
    format!("- {}{}{}{}", node.role, name, attrs_of(node), value)
}

struct Walk<'a> {
    options: &'a SnapshotOptions,
    max_depth: f64,
    lines: Vec<String>,
    refs: Map<String, Value>,
}

impl Walk<'_> {
    fn visit(&mut self, list: &[SnapshotNode], depth: usize) {
        if depth as f64 >= self.max_depth {
            return;
        }
        let indent = "  ".repeat(depth);
        for node in list {
            self.lines.push(format!("{indent}{}", line_for(node)));
            if let Some(node_ref) = non_empty(node.node_ref.as_deref()) {
                self.refs.insert(
                    node_ref.to_owned(),
                    json!({"role": node.role, "name": node.name}),
                );
            }
            if self.options.urls
                && let Some(url) = non_empty(node.url.as_deref())
            {
                self.lines.push(format!("{indent}  - /url: {url}"));
            }
            self.visit(&node.children, depth + 1);
        }
    }
}

pub fn format_snapshot(root: &[SnapshotNode], options: &SnapshotOptions) -> FormattedSnapshot {
    let mut nodes = if options.interactive {
        filter_interactive(root)
    } else {
        root.to_vec()
    };
    if options.compact {
        nodes = compact_nodes(nodes);
    }
    let max_depth = match options.depth {
        Some(depth) if depth > 0.0 => depth,
        _ => f64::INFINITY,
    };
    let mut walk = Walk {
        options,
        max_depth,
        lines: Vec::new(),
        refs: Map::new(),
    };
    walk.visit(&nodes, 0);
    FormattedSnapshot {
        snapshot: walk.lines.join("\n"),
        refs: walk.refs,
    }
}
