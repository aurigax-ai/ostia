use std::sync::LazyLock;

use ostia_base::js::{static_regex, utf16_len};
use regex::Regex;
use serde_json::{Map, Value};

use crate::string_enum::{StringEnum, string_enum};

pub const VIEW_VERSION: u32 = 1;
pub const OPEN_VIEW_COMMAND: &str = "views.open";
pub const VIEW_FILE_EXTENSION: &str = ".json";
pub static VIEW_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z0-9][a-z0-9-]{0,39}$"));
pub const VIEW_FILE_MAX_BYTES: usize = 64 * 1024;
pub const VIEW_FILES_MAX: usize = 50;
pub const VIEW_MAX_NODES: usize = 200;
pub const VIEW_MAX_DEPTH: usize = 10;
pub const VIEW_MAX_LIST_ITEMS: usize = 50;
pub const VIEW_MAX_RENDERED_NODES: usize = 1000;
pub const VIEW_KV_MAX: usize = 20;
pub const VIEW_DESCRIPTION_MAX: usize = 200;
pub const VIEW_TITLE_MAX: usize = 60;
pub const VIEW_TEXT_MAX: usize = 500;
pub const VIEW_ARGS_MAX: usize = 4096;
pub const VIEW_URL_MAX: usize = 2048;

string_enum!(ViewPlacement {
    Sidebar = "sidebar",
    Panel = "panel",
});

string_enum!(ViewSource {
    Workspace = "workspace",
    Workspaces = "workspaces",
    Panes = "panes",
    Ports = "ports",
    Approvals = "approvals",
    Notifications = "notifications",
    Clock = "clock",
});

string_enum!(ViewIcon {
    Lightning = "lightning",
    Play = "play",
    Stop = "stop",
    Terminal = "terminal",
    Globe = "globe",
    Folder = "folder",
    File = "file",
    GitBranch = "git-branch",
    GitPullRequest = "git-pull-request",
    Bug = "bug",
    Rocket = "rocket",
    Sparkle = "sparkle",
    Robot = "robot",
    Code = "code",
    Book = "book",
    Gear = "gear",
    Wrench = "wrench",
    Refresh = "refresh",
    Search = "search",
    Database = "database",
    Package = "package",
    Flask = "flask",
    Eye = "eye",
    Link = "link",
    Chat = "chat",
    Checklist = "checklist",
    Broom = "broom",
    Bell = "bell",
    Clock = "clock",
    Check = "check",
    Warning = "warning",
    X = "x",
    Circle = "circle",
    Server = "server",
    Plug = "plug",
    User = "user",
    Star = "star",
    Plus = "plus",
    ArrowRight = "arrow-right",
});

string_enum!(ViewTone {
    Neutral = "neutral",
    Muted = "muted",
    Brand = "brand",
    Ok = "ok",
    Warn = "warn",
    Error = "error",
});

string_enum!(ViewIconTone {
    Neutral = "neutral",
    Muted = "muted",
    Ok = "ok",
    Warn = "warn",
    Error = "error",
});

string_enum!(ViewGap {
    None = "none",
    Sm = "sm",
    Md = "md",
    Lg = "lg",
});

string_enum!(ViewJustify {
    Start = "start",
    Between = "between",
    End = "end",
});

string_enum!(ViewTextSize {
    Xs = "xs",
    Sm = "sm",
    Base = "base",
});

string_enum!(ViewWeight {
    Regular = "regular",
    Medium = "medium",
    Semibold = "semibold",
});

string_enum!(ViewButtonVariant {
    Default = "default",
    Outline = "outline",
    Ghost = "ghost",
});

string_enum!(ViewNodeType {
    Stack = "stack",
    Row = "row",
    Section = "section",
    Text = "text",
    Badge = "badge",
    Icon = "icon",
    List = "list",
    Button = "button",
    Link = "link",
    Progress = "progress",
    Kv = "kv",
    Divider = "divider",
});

pub const VIEW_NODE_TYPES: &[&str] = ViewNodeType::ALL;

#[derive(Debug, Clone, PartialEq)]
pub enum ViewAction {
    Command {
        command: String,
        args: Option<Map<String, Value>>,
    },
    OpenUrl(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewNode {
    pub condition: Option<String>,
    pub kind: NodeKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NodeKind {
    Stack {
        children: Vec<ViewNode>,
        gap: Option<ViewGap>,
    },
    Row {
        children: Vec<ViewNode>,
        gap: Option<ViewGap>,
        justify: Option<ViewJustify>,
        wrap: Option<bool>,
    },
    Section {
        title: String,
        children: Vec<ViewNode>,
        collapsed: Option<bool>,
    },
    Text {
        text: String,
        tone: Option<ViewTone>,
        size: Option<ViewTextSize>,
        weight: Option<ViewWeight>,
        mono: Option<bool>,
        truncate: Option<bool>,
    },
    Badge {
        text: String,
        tone: Option<ViewTone>,
    },
    Icon {
        name: ViewIcon,
        tone: Option<ViewIconTone>,
        label: Option<String>,
    },
    List {
        source: String,
        as_name: String,
        limit: Option<usize>,
        item: Box<ViewNode>,
        empty: Option<String>,
        gap: Option<ViewGap>,
    },
    Button {
        label: String,
        icon: Option<ViewIcon>,
        variant: Option<ViewButtonVariant>,
        action: ViewAction,
    },
    Link {
        label: String,
        url: String,
    },
    Progress {
        value: ProgressValue,
        max: Option<f64>,
        label: Option<String>,
        tone: Option<ViewTone>,
    },
    Kv {
        items: Vec<KvPair>,
    },
    Divider,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProgressValue {
    Fixed(f64),
    Template(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct KvPair {
    pub key: String,
    pub value: String,
}

impl ViewNode {
    pub fn node_type(&self) -> ViewNodeType {
        match self.kind {
            NodeKind::Stack { .. } => ViewNodeType::Stack,
            NodeKind::Row { .. } => ViewNodeType::Row,
            NodeKind::Section { .. } => ViewNodeType::Section,
            NodeKind::Text { .. } => ViewNodeType::Text,
            NodeKind::Badge { .. } => ViewNodeType::Badge,
            NodeKind::Icon { .. } => ViewNodeType::Icon,
            NodeKind::List { .. } => ViewNodeType::List,
            NodeKind::Button { .. } => ViewNodeType::Button,
            NodeKind::Link { .. } => ViewNodeType::Link,
            NodeKind::Progress { .. } => ViewNodeType::Progress,
            NodeKind::Kv { .. } => ViewNodeType::Kv,
            NodeKind::Divider => ViewNodeType::Divider,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewDoc {
    pub title: String,
    pub placement: ViewPlacement,
    pub icon: Option<ViewIcon>,
    pub description: Option<String>,
    pub root: ViewNode,
    pub sources: Vec<ViewSource>,
    pub ticks: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewProblem {
    pub path: String,
    pub line: Option<usize>,
    pub message: String,
}

pub fn node_keys(node_type: ViewNodeType) -> &'static [&'static str] {
    match node_type {
        ViewNodeType::Stack => &["children", "gap"],
        ViewNodeType::Row => &["children", "gap", "justify", "wrap"],
        ViewNodeType::Section => &["title", "children", "collapsed"],
        ViewNodeType::Text => &["text", "tone", "size", "weight", "mono", "truncate"],
        ViewNodeType::Badge => &["text", "tone"],
        ViewNodeType::Icon => &["name", "tone", "label"],
        ViewNodeType::List => &["for", "as", "limit", "item", "empty", "gap"],
        ViewNodeType::Button => &["label", "icon", "variant", "action"],
        ViewNodeType::Link => &["label", "url"],
        ViewNodeType::Progress => &["value", "max", "label", "tone"],
        ViewNodeType::Kv => &["items"],
        ViewNodeType::Divider => &[],
    }
}

pub fn is_http_url(raw: &str) -> bool {
    if utf16_len(raw) > VIEW_URL_MAX {
        return false;
    }
    url::Url::parse(raw).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}

pub fn view_name_of(file_name: &str) -> Option<String> {
    let name = file_name.strip_suffix(VIEW_FILE_EXTENSION)?;
    VIEW_NAME.is_match(name).then(|| name.to_owned())
}

pub fn format_view_problem(file: &str, problem: &ViewProblem) -> String {
    let line = problem
        .line
        .filter(|line| *line > 0)
        .map(|line| format!(":{line}"))
        .unwrap_or_default();
    format!("{file}{line}: {}: {}", problem.path, problem.message)
}
