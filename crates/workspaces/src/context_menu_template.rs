use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use regex::Regex;
use serde_json::Value;

static TAB_URL: LazyLock<Regex> = LazyLock::new(|| static_regex(r"(?i)^https?://"));

fn is_tab_url(url: &str) -> bool {
    TAB_URL.is_match(url)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EditFlags {
    pub can_undo: bool,
    pub can_redo: bool,
    pub can_cut: bool,
    pub can_copy: bool,
    pub can_paste: bool,
    pub can_select_all: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextParams {
    pub is_editable: bool,
    pub edit_flags: EditFlags,
    pub selection_text: String,
    pub link_url: String,
    pub media_type: String,
    pub has_image_contents: bool,
    pub referrer_policy: String,
    pub frame_url: String,
    pub page_url: String,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextPage {
    pub navigation: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Referrer {
    pub url: String,
    pub policy: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuRole {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

impl MenuRole {
    pub fn name(self) -> &'static str {
        match self {
            Self::Undo => "undo",
            Self::Redo => "redo",
            Self::Cut => "cut",
            Self::Copy => "copy",
            Self::Paste => "paste",
            Self::SelectAll => "selectAll",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuAction {
    OpenLinkInNewTab { url: String, referrer: Referrer },
    CopyLink(String),
    CopyImage { x: i32, y: i32 },
    Back,
    Forward,
    Reload,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuItem {
    Separator,
    Role {
        role: MenuRole,
        enabled: Option<bool>,
    },
    Action {
        label: String,
        enabled: Option<bool>,
        action: MenuAction,
    },
}

fn link_referrer(params: &ContextParams) -> Referrer {
    let url = if params.frame_url.is_empty() {
        &params.page_url
    } else {
        &params.frame_url
    };
    Referrer {
        url: url.clone(),
        policy: params.referrer_policy.clone(),
    }
}

fn role(role: MenuRole, enabled: Option<bool>) -> MenuItem {
    MenuItem::Role { role, enabled }
}

fn action(text: &Value, key: &str, enabled: Option<bool>, action: MenuAction) -> MenuItem {
    MenuItem::Action {
        label: text
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        enabled,
        action,
    }
}

fn group(items: &mut Vec<MenuItem>, group: Vec<MenuItem>) {
    if group.is_empty() {
        return;
    }
    if !items.is_empty() {
        items.push(MenuItem::Separator);
    }
    items.extend(group);
}

pub fn context_menu_template(
    params: &ContextParams,
    page: &ContextPage,
    can_open_link_in_new_tab: bool,
    text: &Value,
) -> Vec<MenuItem> {
    let mut items = Vec::new();
    let selected = !js_trim(&params.selection_text).is_empty();
    let image = params.media_type == "image" && params.has_image_contents;
    let has_link = !params.link_url.is_empty();
    if params.is_editable {
        let flags = params.edit_flags;
        group(
            &mut items,
            vec![
                role(MenuRole::Undo, Some(flags.can_undo)),
                role(MenuRole::Redo, Some(flags.can_redo)),
            ],
        );
        group(
            &mut items,
            vec![
                role(MenuRole::Cut, Some(flags.can_cut)),
                role(MenuRole::Copy, Some(flags.can_copy)),
                role(MenuRole::Paste, Some(flags.can_paste)),
                role(MenuRole::SelectAll, Some(flags.can_select_all)),
            ],
        );
    } else if selected {
        group(&mut items, vec![role(MenuRole::Copy, None)]);
    }
    if has_link {
        let link = &params.link_url;
        let mut links = Vec::new();
        if can_open_link_in_new_tab && is_tab_url(link) {
            links.push(action(
                text,
                "openLinkInNewTab",
                None,
                MenuAction::OpenLinkInNewTab {
                    url: link.clone(),
                    referrer: link_referrer(params),
                },
            ));
        }
        links.push(action(
            text,
            "copyLink",
            None,
            MenuAction::CopyLink(link.clone()),
        ));
        group(&mut items, links);
    }
    if image {
        group(
            &mut items,
            vec![action(
                text,
                "copyImage",
                None,
                MenuAction::CopyImage {
                    x: params.x,
                    y: params.y,
                },
            )],
        );
    }
    if page.navigation && !params.is_editable && !selected && !has_link && !image {
        group(
            &mut items,
            vec![
                action(text, "back", Some(page.can_go_back), MenuAction::Back),
                action(
                    text,
                    "forward",
                    Some(page.can_go_forward),
                    MenuAction::Forward,
                ),
                action(text, "reload", None, MenuAction::Reload),
            ],
        );
    }
    items
}
