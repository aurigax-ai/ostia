use std::collections::HashMap;
use std::sync::Arc;

use ostia_contract::attention::{
    AttentionState, NotificationEntry, NotificationKind, WorkspaceLiveState,
};
use ostia_contract::extensions::{
    ExtensionChip, ExtensionIcon, ExtensionSidebarItem, PaneChipItem, SidebarKind, SidebarTone,
    WorkspaceChip,
};
use ostia_contract::views::ViewSource;
use ostia_model::attention::PaneAttention;
use ostia_model::layout::types::{Direction, LayoutNode, PaneNode, SplitNode, SurfaceKind};
use ostia_model::views::view_data::{VIEW_NOTIFICATIONS_MAX, ViewDataInputs, build_view_scope};
use ostia_model::workspaces::layout_store::WorkspaceLayout;
use ostia_model::workspaces::workspaces_store::{Workspace, WorkspaceKind};
use serde_json::{Map, Value, json};

fn ws(id: &str, name: &str) -> Workspace {
    Workspace {
        id: id.to_owned(),
        name: name.to_owned(),
        custom_name: None,
        pinned: false,
        kind: WorkspaceKind::Terminal,
        work_dir: format!("/home/u/{name}"),
        state: WorkspaceLiveState::Idle,
        project_dir: None,
        description: None,
    }
}

fn pane(id: &str, title: &str, kind: SurfaceKind) -> LayoutNode {
    LayoutNode::Pane(Arc::new(PaneNode::new(id, title, kind)))
}

fn layout(active: &str) -> WorkspaceLayout {
    WorkspaceLayout {
        root: LayoutNode::Split(Arc::new(SplitNode {
            id: "s1".to_owned(),
            direction: Direction::Horizontal,
            children: vec![
                pane("p1", "zsh", SurfaceKind::Terminal),
                LayoutNode::Pane(Arc::new(PaneNode {
                    url: Some("https://x".to_owned()),
                    ..PaneNode::new("p2", "docs", SurfaceKind::Browser)
                })),
            ],
            sizes: vec![1.0, 1.0],
            name: None,
            folded: false,
        })),
        active_pane_id: active.to_owned(),
        zoomed_pane_id: None,
        equalized: None,
    }
}

fn sidebar_item(ext_id: &str, key: &str, text: &str, kind: SidebarKind) -> ExtensionSidebarItem {
    ExtensionSidebarItem {
        ext_id: ext_id.to_owned(),
        key: key.to_owned(),
        workspace_id: Some("w1".to_owned()),
        text: text.to_owned(),
        icon: None,
        badge: None,
        tone: SidebarTone::Neutral,
        kind,
        url: None,
    }
}

fn chip(
    ext_id: &str,
    id: &str,
    workspace_id: &str,
    items: Option<Vec<PaneChipItem>>,
) -> WorkspaceChip {
    WorkspaceChip {
        chip: ExtensionChip {
            ext_id: ext_id.to_owned(),
            id: id.to_owned(),
            text: items.as_ref().map_or(0, Vec::len).to_string(),
            tooltip: None,
            tone: SidebarTone::Neutral,
            icon: Some(ExtensionIcon::Plugs),
            items,
            command: None,
            url: None,
        },
        workspace_id: workspace_id.to_owned(),
    }
}

fn chip_item(url: Option<&str>) -> PaneChipItem {
    PaneChipItem {
        text: "item".to_owned(),
        detail: None,
        port: None,
        url: url.map(str::to_owned),
    }
}

fn port_items(ports: &[u16]) -> Vec<PaneChipItem> {
    ports
        .iter()
        .map(|port| chip_item(Some(&format!("http://localhost:{port}/"))))
        .collect()
}

fn ports_chip(workspace_id: &str, ext_id: &str, ports: &[u16]) -> WorkspaceChip {
    chip(ext_id, "ports", workspace_id, Some(port_items(ports)))
}

fn agent_of(pane_id: &str) -> Option<String> {
    (pane_id == "p1").then(|| "claude".to_owned())
}

fn inputs() -> ViewDataInputs<'static> {
    let mut project = ws("w1", "ostia");
    project.project_dir = Some("~/ostia".to_owned());
    project.state = WorkspaceLiveState::Waiting;
    ViewDataInputs {
        workspaces: vec![project, ws("w2", "site")],
        active_workspace_id: Some("w1".to_owned()),
        by_workspace: HashMap::from([("w1".to_owned(), layout("p2"))]),
        attention: HashMap::from([(
            "p1".to_owned(),
            PaneAttention {
                state: AttentionState::Waiting,
                unread: true,
                message: Some("needs input".to_owned()),
                at: 1.0,
            },
        )]),
        sidebar: vec![
            sidebar_item("ports", "ssh", "me@box", SidebarKind::Live),
            sidebar_item("git", "branch", "main +2", SidebarKind::Location),
        ],
        workspace_chips: vec![
            ports_chip("w1", "ports", &[5173]),
            ports_chip("w2", "ports", &[3000]),
            ports_chip("w1", "other", &[1]),
            chip("git", "branch", "w1", None),
        ],
        approvals: 2,
        notifications: vec![],
        agent_of: &agent_of,
        now: 1_000,
    }
}

fn notification(id: &str, ts: &str, title: &str) -> NotificationEntry {
    NotificationEntry {
        id: id.to_owned(),
        ts: ts.to_owned(),
        kind: NotificationKind::Message,
        title: title.to_owned(),
        body: None,
        from: "pane".to_owned(),
        pane_id: None,
        ext_id: None,
        panel_path: None,
    }
}

fn scope_of(data: &ViewDataInputs, sources: &[ViewSource]) -> Map<String, Value> {
    build_view_scope(data, sources)
}

fn field(data: &ViewDataInputs, source: ViewSource, key: &str) -> Value {
    scope_of(data, &[source])
        .get(key)
        .cloned()
        .unwrap_or(Value::Null)
}

#[test]
fn describes_every_workspace_with_unread_count_git_summary_and_ports() {
    let scope = scope_of(&inputs(), &[ViewSource::Workspaces, ViewSource::Workspace]);
    let workspaces = scope["workspaces"].as_array().unwrap();
    assert_eq!(
        workspaces[0],
        json!({
            "id": "w1",
            "index": 0,
            "name": "ostia",
            "project": { "name": "ostia", "path": "~/ostia" },
            "dir": "/home/u/ostia",
            "description": null,
            "state": "waiting",
            "unread": 1,
            "active": true,
            "pinned": false,
            "panes": 2,
            "git": "main +2",
            "ports": [{ "port": 5173, "url": "http://localhost:5173/" }],
        })
    );
    let second = &workspaces[1];
    assert_eq!(second["id"], "w2");
    assert_eq!(second["index"], 1);
    assert_eq!(second["unread"], 0);
    assert_eq!(second["active"], false);
    assert_eq!(second["panes"], 0);
    assert_eq!(second["git"], Value::Null);
    assert_eq!(scope["workspace"], workspaces[0]);
}

#[test]
fn lists_the_panes_of_the_current_workspace_with_their_agent_and_attention() {
    assert_eq!(
        field(&inputs(), ViewSource::Panes, "panes"),
        json!([
            {
                "id": "p1",
                "title": "zsh",
                "kind": "terminal",
                "agent": "claude",
                "attention": "waiting",
                "unread": true,
                "message": "needs input",
                "active": false,
            },
            {
                "id": "p2",
                "title": "docs",
                "kind": "browser",
                "agent": null,
                "attention": "none",
                "unread": false,
                "message": null,
                "active": true,
            },
        ])
    );
}

#[test]
fn has_no_current_workspace_or_panes_when_none_is_open() {
    let mut data = inputs();
    data.active_workspace_id = None;
    let scope = scope_of(&data, &[ViewSource::Workspace, ViewSource::Panes]);
    assert_eq!(scope["workspace"], Value::Null);
    assert_eq!(scope["panes"], json!([]));
}

#[test]
fn gathers_listening_ports_from_the_ports_extension_only_sorted() {
    assert_eq!(
        field(&inputs(), ViewSource::Ports, "ports"),
        json!([
            { "port": 3000, "url": "http://localhost:3000/", "workspace": "site", "workspaceId": "w2" },
            { "port": 5173, "url": "http://localhost:5173/", "workspace": "ostia", "workspaceId": "w1" },
        ])
    );
}

#[test]
fn puts_the_newest_notifications_first_and_caps_them() {
    let mut data = inputs();
    data.notifications = (0..60)
        .map(|i| {
            let ts = format!("1970-01-01T00:{:02}:{:02}.000Z", i / 60, i % 60);
            notification(&format!("n{i}"), &ts, &format!("note {i}"))
        })
        .collect();
    let list = field(&data, ViewSource::Notifications, "notifications");
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), VIEW_NOTIFICATIONS_MAX);
    assert_eq!(list[0]["title"], "note 59");
    assert_eq!(list[0]["at"], json!(59_000));
}

#[test]
fn includes_only_the_sources_a_view_asks_for() {
    let sources = [ViewSource::Approvals, ViewSource::Clock];
    let scope = scope_of(&inputs(), &sources);
    assert_eq!(scope.keys().collect::<Vec<_>>(), ["approvals", "clock"]);
    assert_eq!(
        Value::Object(scope),
        json!({ "approvals": { "pending": 2 }, "clock": { "now": 1_000 } })
    );
}

#[test]
fn gives_the_workspaces_source_alone_no_current_workspace() {
    let only_list = scope_of(&inputs(), &[ViewSource::Workspaces]);
    assert!(only_list.contains_key("workspaces"));
    assert!(!only_list.contains_key("workspace"));
    let only_current = scope_of(&inputs(), &[ViewSource::Workspace]);
    assert!(only_current.contains_key("workspace"));
    assert!(!only_current.contains_key("workspaces"));
    assert!(scope_of(&inputs(), &[]).is_empty());
}

#[test]
fn names_a_workspace_by_its_custom_name_and_reports_its_description_and_pin() {
    let mut data = inputs();
    data.workspaces[1].custom_name = Some("Site".to_owned());
    data.workspaces[1].description = Some("the site".to_owned());
    data.workspaces[1].pinned = true;
    let workspaces = field(&data, ViewSource::Workspaces, "workspaces");
    assert_eq!(workspaces[1]["name"], "Site");
    assert_eq!(workspaces[1]["description"], "the site");
    assert_eq!(workspaces[1]["pinned"], true);
    assert_eq!(workspaces[1]["project"], Value::Null);
}

#[test]
fn reports_no_active_workspace_when_the_active_id_matches_none() {
    let mut data = inputs();
    data.active_workspace_id = Some("gone".to_owned());
    let scope = scope_of(&data, &[ViewSource::Workspace, ViewSource::Workspaces]);
    assert_eq!(scope["workspace"], Value::Null);
    assert!(
        scope["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["active"] == false)
    );
}

#[test]
fn skips_ports_without_a_usable_port_number() {
    let mut data = inputs();
    data.workspace_chips = vec![chip(
        "ports",
        "ports",
        "w1",
        Some(vec![
            chip_item(None),
            chip_item(Some("not a url")),
            chip_item(Some("http://localhost/")),
            chip_item(Some("http://localhost:0/")),
            chip_item(Some("http://localhost:8080/")),
        ]),
    )];
    let ports = field(&data, ViewSource::Ports, "ports");
    assert_eq!(
        ports,
        json!([{ "port": 8080, "url": "http://localhost:8080/", "workspace": "ostia", "workspaceId": "w1" }])
    );
}

#[test]
fn skips_a_ports_chip_with_no_items_and_names_an_unknown_workspace_empty() {
    let mut data = inputs();
    data.workspace_chips = vec![
        chip("ports", "ports", "w1", None),
        ports_chip("gone", "ports", &[9000]),
    ];
    assert_eq!(
        field(&data, ViewSource::Ports, "ports"),
        json!([{ "port": 9000, "url": "http://localhost:9000/", "workspace": "", "workspaceId": "gone" }])
    );
}

#[test]
fn sorts_ports_by_number_and_lists_them_on_their_own_workspace() {
    let mut data = inputs();
    data.workspace_chips = vec![ports_chip("w1", "ports", &[9000, 80, 5173])];
    let workspaces = field(&data, ViewSource::Workspaces, "workspaces");
    assert_eq!(
        workspaces[0]["ports"],
        json!([
            { "port": 80, "url": "http://localhost:80/" },
            { "port": 5173, "url": "http://localhost:5173/" },
            { "port": 9000, "url": "http://localhost:9000/" },
        ])
    );
    assert_eq!(workspaces[1]["ports"], json!([]));
}

#[test]
fn takes_the_git_summary_only_from_the_git_extension_with_text() {
    let mut data = inputs();
    data.sidebar = vec![
        sidebar_item("ports", "ssh", "me@box", SidebarKind::Live),
        sidebar_item("git", "branch", "", SidebarKind::Location),
        sidebar_item("git", "dirty", "dirty", SidebarKind::Location),
    ];
    data.sidebar[2].workspace_id = Some("w2".to_owned());
    let workspaces = field(&data, ViewSource::Workspaces, "workspaces");
    assert_eq!(workspaces[0]["git"], Value::Null);
    assert_eq!(workspaces[1]["git"], "dirty");
}

#[test]
fn gives_an_agent_to_terminal_panes_only() {
    let everyone = |_: &str| Some("claude".to_owned());
    let mut data = inputs();
    data.agent_of = &everyone;
    let panes = field(&data, ViewSource::Panes, "panes");
    assert_eq!(panes[0]["agent"], "claude");
    assert_eq!(panes[1]["agent"], Value::Null);
}

#[test]
fn reads_a_notification_body_and_zero_for_an_unreadable_time() {
    let mut data = inputs();
    let mut dated = notification("a", "2020-01-01T00:00:00.000Z", "dated");
    dated.body = Some("details".to_owned());
    dated.kind = NotificationKind::Waiting;
    data.notifications = vec![notification("b", "not a time", "broken"), dated];
    assert_eq!(
        field(&data, ViewSource::Notifications, "notifications"),
        json!([
            {
                "id": "a",
                "title": "dated",
                "body": "details",
                "kind": "waiting",
                "from": "pane",
                "at": 1_577_836_800_000_i64,
            },
            {
                "id": "b",
                "title": "broken",
                "body": null,
                "kind": "message",
                "from": "pane",
                "at": 0,
            },
        ])
    );
}

#[test]
fn keeps_notifications_with_the_same_time_in_input_order() {
    let mut data = inputs();
    data.notifications = ["a", "b", "c"]
        .iter()
        .map(|id| notification(id, "2020-01-01T00:00:00.000Z", id))
        .collect();
    let list = field(&data, ViewSource::Notifications, "notifications");
    let ids: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a", "b", "c"]);
}
