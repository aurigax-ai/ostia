use ostia_base::js::{js_number_text, js_to_number};
use ostia_contract::json_located::{child_index_path, child_path};
use ostia_contract::view_bindings::ViewFormat;
use ostia_contract::views::{
    KvPair, NodeKind, ProgressValue, VIEW_MAX_LIST_ITEMS, VIEW_MAX_RENDERED_NODES, ViewAction,
    ViewButtonVariant, ViewDoc, ViewGap, ViewIcon, ViewIconTone, ViewJustify, ViewNode,
    ViewTextSize, ViewTone, ViewWeight, is_http_url,
};
use serde_json::{Map, Value};

use super::view_bindings::{ViewScope, resolve_args, resolve_text, resolve_value, truthy};

#[derive(Clone, Debug, PartialEq)]
pub enum ViewActionTarget {
    Command {
        command: String,
        template: Option<Map<String, Value>>,
        args: Option<Map<String, Value>>,
    },
    Url {
        url: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RenderNode {
    pub key: String,
    pub kind: RenderKind,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RenderKind {
    Stack {
        gap: ViewGap,
        children: Vec<RenderNode>,
    },
    Row {
        gap: ViewGap,
        justify: ViewJustify,
        wrap: bool,
        children: Vec<RenderNode>,
    },
    Section {
        title: String,
        collapsed: bool,
        children: Vec<RenderNode>,
    },
    Text {
        text: String,
        tone: ViewTone,
        size: ViewTextSize,
        weight: ViewWeight,
        mono: bool,
        truncate: bool,
    },
    Badge {
        text: String,
        tone: ViewTone,
    },
    Icon {
        name: ViewIcon,
        tone: ViewIconTone,
        label: String,
    },
    List {
        gap: ViewGap,
        items: Vec<RenderNode>,
        empty: Option<String>,
    },
    Button {
        label: String,
        icon: Option<ViewIcon>,
        variant: ViewButtonVariant,
        action: ViewActionTarget,
    },
    Link {
        label: String,
        url: Option<String>,
    },
    Progress {
        ratio: f64,
        label: String,
        tone: ViewTone,
    },
    Kv {
        items: Vec<KvPair>,
    },
    Divider,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BudgetProblem {
    List {
        path: String,
        count: usize,
        max: usize,
    },
    Nodes {
        max: usize,
    },
}

type Expanded = Result<Option<RenderNode>, BudgetProblem>;

fn safe_url(value: &Value) -> Option<String> {
    match value {
        Value::String(url) if is_http_url(url) => Some(url.clone()),
        _ => None,
    }
}

fn item_key(item: &Value, index: usize) -> String {
    if let Some(id) = item.as_object().and_then(|map| map.get("id")) {
        match id {
            Value::String(text) => return format!("#{text}"),
            Value::Number(number) => {
                if let Some(n) = number.as_f64() {
                    return format!("#{}", js_number_text(n));
                }
            }
            _ => {}
        }
    }
    format!("@{index}")
}

fn ratio_of(value: &Value, max: f64) -> f64 {
    let n = js_to_number(value);
    if !n.is_finite() || max <= 0.0 {
        return 0.0;
    }
    (n / max).clamp(0.0, 1.0)
}

fn non_empty_text(template: Option<&String>, text: impl Fn(&str) -> String) -> Option<String> {
    template.filter(|t| !t.is_empty()).map(|t| text(t))
}

struct Expander<'a> {
    fmt: &'a ViewFormat,
    count: usize,
}

impl Expander<'_> {
    fn children(
        &mut self,
        children: &[ViewNode],
        path: &str,
        key: &str,
        scope: &ViewScope,
    ) -> Result<Vec<RenderNode>, BudgetProblem> {
        let base = child_path(path, "children");
        let mut out = Vec::new();
        for (i, child) in children.iter().enumerate() {
            let at = child_index_path(&base, i);
            if let Some(node) = self.expand(child, &at, &format!("{key}/{i}"), scope)? {
                out.push(node);
            }
        }
        Ok(out)
    }

    fn button_action(&self, action: &ViewAction, scope: &ViewScope) -> ViewActionTarget {
        match action {
            ViewAction::OpenUrl(template) => ViewActionTarget::Url {
                url: safe_url(&resolve_value(template, scope, self.fmt)),
            },
            ViewAction::Command { command, args } => ViewActionTarget::Command {
                command: command.clone(),
                template: args.clone(),
                args: args.as_ref().map(|template| {
                    match resolve_args(&Value::Object(template.clone()), scope, self.fmt) {
                        Value::Object(resolved) => resolved,
                        _ => Map::new(),
                    }
                }),
            },
        }
    }

    fn expand(&mut self, node: &ViewNode, path: &str, key: &str, scope: &ViewScope) -> Expanded {
        if let Some(condition) = &node.condition
            && !truthy(&resolve_value(condition, scope, self.fmt))
        {
            return Ok(None);
        }
        self.count += 1;
        if self.count > VIEW_MAX_RENDERED_NODES {
            return Err(BudgetProblem::Nodes {
                max: VIEW_MAX_RENDERED_NODES,
            });
        }
        let fmt = self.fmt;
        let text = |template: &str| resolve_text(template, scope, fmt);
        let kind = match &node.kind {
            NodeKind::Stack { children, gap } => RenderKind::Stack {
                gap: gap.unwrap_or(ViewGap::Sm),
                children: self.children(children, path, key, scope)?,
            },
            NodeKind::Row {
                children,
                gap,
                justify,
                wrap,
            } => RenderKind::Row {
                gap: gap.unwrap_or(ViewGap::Sm),
                justify: justify.unwrap_or(ViewJustify::Start),
                wrap: wrap.unwrap_or(false),
                children: self.children(children, path, key, scope)?,
            },
            NodeKind::Section {
                title,
                children,
                collapsed,
            } => RenderKind::Section {
                title: text(title),
                collapsed: collapsed.unwrap_or(false),
                children: self.children(children, path, key, scope)?,
            },
            NodeKind::Text {
                text: template,
                tone,
                size,
                weight,
                mono,
                truncate,
            } => RenderKind::Text {
                text: text(template),
                tone: tone.unwrap_or(ViewTone::Neutral),
                size: size.unwrap_or(ViewTextSize::Sm),
                weight: weight.unwrap_or(ViewWeight::Regular),
                mono: mono.unwrap_or(false),
                truncate: truncate.unwrap_or(false),
            },
            NodeKind::Badge {
                text: template,
                tone,
            } => RenderKind::Badge {
                text: text(template),
                tone: tone.unwrap_or(ViewTone::Neutral),
            },
            NodeKind::Icon { name, tone, label } => RenderKind::Icon {
                name: *name,
                tone: tone.unwrap_or(ViewIconTone::Muted),
                label: non_empty_text(label.as_ref(), text).unwrap_or_default(),
            },
            NodeKind::List {
                source,
                as_name,
                limit,
                item,
                empty,
                gap,
            } => {
                let raw = resolve_value(&format!("{{{{{source}}}}}"), scope, fmt);
                let all: &[Value] = raw.as_array().map_or(&[], Vec::as_slice);
                let max = limit.unwrap_or(VIEW_MAX_LIST_ITEMS);
                if limit.is_none() && all.len() > VIEW_MAX_LIST_ITEMS {
                    return Err(BudgetProblem::List {
                        path: path.to_owned(),
                        count: all.len(),
                        max,
                    });
                }
                let item_path = child_path(path, "item");
                let mut items = Vec::new();
                for (i, entry) in all.iter().take(max).enumerate() {
                    let mut inner = scope.clone();
                    inner.insert(as_name.clone(), entry.clone());
                    let entry_key = format!("{key}{}", item_key(entry, i));
                    if let Some(rendered) = self.expand(item, &item_path, &entry_key, &inner)? {
                        items.push(rendered);
                    }
                }
                let empty = if items.is_empty() {
                    non_empty_text(empty.as_ref(), text)
                } else {
                    None
                };
                RenderKind::List {
                    gap: gap.unwrap_or(ViewGap::None),
                    items,
                    empty,
                }
            }
            NodeKind::Button {
                label,
                icon,
                variant,
                action,
            } => RenderKind::Button {
                label: text(label),
                icon: *icon,
                variant: variant.unwrap_or(ViewButtonVariant::Outline),
                action: self.button_action(action, scope),
            },
            NodeKind::Link { label, url } => RenderKind::Link {
                label: text(label),
                url: safe_url(&resolve_value(url, scope, self.fmt)),
            },
            NodeKind::Progress {
                value,
                max,
                label,
                tone,
            } => {
                let value = match value {
                    ProgressValue::Fixed(number) => Value::from(*number),
                    ProgressValue::Template(template) => resolve_value(template, scope, self.fmt),
                };
                RenderKind::Progress {
                    ratio: ratio_of(&value, max.unwrap_or(100.0)),
                    label: non_empty_text(label.as_ref(), text).unwrap_or_default(),
                    tone: tone.unwrap_or(ViewTone::Brand),
                }
            }
            NodeKind::Kv { items } => RenderKind::Kv {
                items: items
                    .iter()
                    .map(|pair| KvPair {
                        key: text(&pair.key),
                        value: text(&pair.value),
                    })
                    .collect(),
            },
            NodeKind::Divider => RenderKind::Divider,
        };
        Ok(Some(RenderNode {
            key: key.to_owned(),
            kind,
        }))
    }
}

pub fn expand_view(doc: &ViewDoc, data: &ViewScope, fmt: &ViewFormat) -> Expanded {
    Expander { fmt, count: 0 }.expand(&doc.root, "root", "root", data)
}
