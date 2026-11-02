#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use ostia_base::js::JsNumber;
use ostia_contract::agent_resume::{AgentResume, ResumableAgent};
use ostia_model::ids::IdMint;
use ostia_model::layout::pane_fields::{
    first_pane_of_kind, follow_moved_file, has_locked_pane, rename_pane, set_pane_browser,
    set_pane_browser_device, set_pane_cwd, set_pane_diff, set_pane_editor, set_pane_hibernated,
    set_pane_keep_awake, set_pane_locked, set_pane_resume, set_pane_spawn_dir, set_pane_title,
    set_pane_url, settle_spawn_dir,
};
use ostia_model::layout::tree::{create_pane, find_pane, split_of, tabs_of};
use ostia_model::layout::types::{Direction, LayoutNode, PaneNode, SurfaceKind, TabNode};
use ostia_workspaces::browser_device::{BrowserDevice, DeviceZoom};
use ostia_workspaces::stored_resume::StoredResume;

fn pane_of(ids: &mut IdMint, kind: SurfaceKind) -> LayoutNode {
    create_pane(ids, kind, None, None).into()
}

fn terminal(ids: &mut IdMint) -> LayoutNode {
    pane_of(ids, SurfaceKind::Terminal)
}

fn edited(ids: &mut IdMint, edit: impl FnOnce(&mut PaneNode)) -> LayoutNode {
    let mut pane = create_pane(ids, SurfaceKind::Terminal, None, None);
    edit(&mut pane);
    pane.into()
}

fn split(ids: &mut IdMint, direction: Direction, children: Vec<LayoutNode>) -> LayoutNode {
    split_of(ids, direction, children).into()
}

fn child(node: &LayoutNode, index: usize) -> LayoutNode {
    let LayoutNode::Split(split) = node else {
        panic!("not a split")
    };
    split.children[index].clone()
}

fn pane_arc(node: &LayoutNode) -> Arc<PaneNode> {
    let LayoutNode::Pane(pane) = node else {
        panic!("not a pane")
    };
    pane.clone()
}

fn found(root: &LayoutNode, id: &str) -> Arc<PaneNode> {
    find_pane(root, id).unwrap()
}

fn tab(node: &LayoutNode) -> TabNode {
    node.clone().into_tab().unwrap()
}

fn stored(agent: ResumableAgent, id: &str, cwd: Option<&str>) -> StoredResume {
    StoredResume {
        resume: AgentResume {
            agent,
            id: id.to_owned(),
            cwd: cwd.map(str::to_owned),
            args: Vec::new(),
            typed: None,
        },
        typed: None,
    }
}

fn default_device() -> BrowserDevice {
    BrowserDevice {
        preset: "responsive".to_owned(),
        width: 400,
        height: 800,
        dpr: JsNumber(1.0),
        zoom: DeviceZoom::Fit,
    }
}

fn rotated(device: &BrowserDevice) -> BrowserDevice {
    BrowserDevice {
        width: device.height,
        height: device.width,
        ..device.clone()
    }
}

fn browser_pane(ids: &mut IdMint) -> LayoutNode {
    let root = terminal(ids);
    set_pane_browser(&root, root.id(), "https://example.com", None)
}

#[test]
fn sets_cwd_on_the_matching_leaf_leaving_siblings_untouched() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![a.clone(), b.clone()]);
    let next = set_pane_cwd(&root, b.id(), "/work/api");
    assert_eq!(found(&next, b.id()).cwd.as_deref(), Some("/work/api"));
    assert_eq!(found(&next, a.id()).cwd, None);
}

#[test]
fn sets_cwd_when_the_root_pane_itself_matches() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let next = set_pane_cwd(&root, root.id(), "/home");
    assert!(!next.is_same(&root));
    assert_eq!(found(&next, root.id()).cwd.as_deref(), Some("/home"));
}

#[test]
fn returns_the_same_lone_root_pane_when_the_id_does_not_match() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    assert!(set_pane_cwd(&root, "ghost", "/x").is_same(&root));
}

#[test]
fn returns_the_identical_tree_when_the_cwd_is_unchanged() {
    let mut ids = IdMint::default();
    let a: LayoutNode = create_pane(&mut ids, SurfaceKind::Terminal, None, Some("/work")).into();
    let b: LayoutNode = create_pane(&mut ids, SurfaceKind::Terminal, None, Some("/home")).into();
    let c = terminal(&mut ids);
    let inner = split(&mut ids, Direction::Vertical, vec![b.clone(), c]);
    let root = split(&mut ids, Direction::Horizontal, vec![a, inner]);
    assert!(set_pane_cwd(&root, b.id(), "/home").is_same(&root));
}

#[test]
fn keeps_untouched_subtrees_referentially_identical_when_one_cwd_changes() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let c = terminal(&mut ids);
    let d = terminal(&mut ids);
    let inner = split(&mut ids, Direction::Vertical, vec![c, d]);
    let root = split(
        &mut ids,
        Direction::Horizontal,
        vec![a.clone(), inner.clone()],
    );
    let next = set_pane_cwd(&root, a.id(), "/x");
    assert!(!next.is_same(&root));
    assert!(child(&next, 1).is_same(&inner));
}

#[test]
fn rename_pane_pins_the_new_title_so_program_titles_no_longer_replace_it() {
    let mut ids = IdMint::default();
    let pane = edited(&mut ids, |pane| pane.default_title = true);
    let other = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![other, pane.clone()]);
    let renamed = rename_pane(&root, pane.id(), "  W9 控制面補齊 ");
    let named = found(&renamed, pane.id());
    assert_eq!(named.title, "W9 控制面補齊");
    assert!(named.title_pinned);
    assert!(!named.default_title);
    let after = set_pane_title(&renamed, pane.id(), "vim README.md");
    assert!(after.is_same(&renamed));
}

#[test]
fn rename_pane_unpins_on_an_empty_title_and_keeps_the_current_one_until_a_program_sets_another() {
    let mut ids = IdMint::default();
    let pane = terminal(&mut ids);
    let other = terminal(&mut ids);
    let pair = split(&mut ids, Direction::Horizontal, vec![other, pane.clone()]);
    let root = rename_pane(&pair, pane.id(), "worker");
    let cleared = rename_pane(&root, pane.id(), "");
    assert!(!found(&cleared, pane.id()).title_pinned);
    assert_eq!(found(&cleared, pane.id()).title, "worker");
    let retitled = set_pane_title(&cleared, pane.id(), "htop");
    assert_eq!(found(&retitled, pane.id()).title, "htop");
}

#[test]
fn rename_pane_returns_the_identical_tree_when_nothing_changes() {
    let mut ids = IdMint::default();
    let pane = terminal(&mut ids);
    let other = terminal(&mut ids);
    let pair = split(&mut ids, Direction::Horizontal, vec![other, pane.clone()]);
    let root = rename_pane(&pair, pane.id(), "worker");
    assert!(rename_pane(&root, pane.id(), "worker").is_same(&root));
    let x = terminal(&mut ids);
    let y = terminal(&mut ids);
    let plain = split(&mut ids, Direction::Horizontal, vec![x, y]);
    assert!(rename_pane(&plain, "missing", "").is_same(&plain));
}

#[test]
fn updates_the_url_of_the_matching_pane_and_keeps_its_title() {
    let mut ids = IdMint::default();
    let pane: LayoutNode =
        create_pane(&mut ids, SurfaceKind::Browser, Some("example.com"), None).into();
    let other = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![other, pane.clone()]);
    let next = set_pane_url(&root, pane.id(), "https://example.com/next");
    assert_eq!(
        found(&next, pane.id()).url.as_deref(),
        Some("https://example.com/next")
    );
    assert_eq!(found(&next, pane.id()).title, "example.com");
}

#[test]
fn set_pane_url_returns_the_identical_tree_when_the_url_is_unchanged() {
    let mut ids = IdMint::default();
    let mut browser = create_pane(&mut ids, SurfaceKind::Browser, None, None);
    browser.url = Some("https://a.test/".to_owned());
    let pane: LayoutNode = browser.into();
    let other = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![other, pane.clone()]);
    assert!(set_pane_url(&root, pane.id(), "https://a.test/").is_same(&root));
}

#[test]
fn returns_the_first_pane_of_the_kind_in_tree_order_descending_into_splits() {
    let mut ids = IdMint::default();
    let t1 = pane_of(&mut ids, SurfaceKind::Terminal);
    let e1 = pane_of(&mut ids, SurfaceKind::Editor);
    let e2 = pane_of(&mut ids, SurfaceKind::Editor);
    let inner = split(&mut ids, Direction::Vertical, vec![e1.clone(), e2]);
    let root = split(&mut ids, Direction::Horizontal, vec![t1, inner]);
    let first = first_pane_of_kind(&root, SurfaceKind::Editor).unwrap();
    assert!(Arc::ptr_eq(&first, &pane_arc(&e1)));
}

#[test]
fn returns_the_root_pane_when_it_matches_the_kind() {
    let mut ids = IdMint::default();
    let root = pane_of(&mut ids, SurfaceKind::Agent);
    let first = first_pane_of_kind(&root, SurfaceKind::Agent).unwrap();
    assert!(Arc::ptr_eq(&first, &pane_arc(&root)));
}

#[test]
fn returns_none_when_no_pane_has_the_kind() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![a, b]);
    assert!(first_pane_of_kind(&root, SurfaceKind::Browser).is_none());
}

#[test]
fn turns_the_matching_pane_into_an_editor_and_derives_cwd_from_the_file_dir() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![a.clone(), b.clone()]);
    let next = set_pane_editor(&root, b.id(), "main.ts", "/src/app/main.ts");
    let pane = found(&next, b.id());
    assert_eq!(pane.kind, SurfaceKind::Editor);
    assert_eq!(pane.title, "main.ts");
    assert_eq!(pane.file_path.as_deref(), Some("/src/app/main.ts"));
    assert_eq!(pane.cwd.as_deref(), Some("/src/app"));
    assert_eq!(found(&next, a.id()).kind, SurfaceKind::Terminal);
}

#[test]
fn gives_a_remote_file_no_folder_so_it_never_moves_the_local_tree_or_workspace() {
    let mut ids = IdMint::default();
    let term: LayoutNode = create_pane(
        &mut ids,
        SurfaceKind::Terminal,
        Some("zsh"),
        Some("/home/u/proj"),
    )
    .into();
    let next = set_pane_editor(
        &term,
        term.id(),
        "app.conf",
        "remote://abcdef012345/srv/app/app.conf",
    );
    let pane = found(&next, term.id());
    assert_eq!(pane.kind, SurfaceKind::Editor);
    assert_eq!(
        pane.file_path.as_deref(),
        Some("remote://abcdef012345/srv/app/app.conf")
    );
    assert_eq!(pane.cwd, None);
}

#[test]
fn falls_back_to_root_cwd_for_a_file_at_the_filesystem_root() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let next = set_pane_editor(&root, root.id(), "notes.txt", "/notes.txt");
    let pane = found(&next, root.id());
    assert_eq!(pane.kind, SurfaceKind::Editor);
    assert_eq!(pane.cwd.as_deref(), Some("/"));
}

#[test]
fn falls_back_to_root_cwd_for_a_bare_file_name_with_no_slash() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let next = set_pane_editor(&root, root.id(), "notes.txt", "notes.txt");
    assert_eq!(found(&next, root.id()).cwd.as_deref(), Some("/"));
}

#[test]
fn set_pane_editor_leaves_a_non_matching_lone_pane_unchanged() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    assert!(set_pane_editor(&root, "ghost", "t", "/a/t.ts").is_same(&root));
}

#[test]
fn turns_the_matching_pane_into_a_browser_and_derives_the_title_from_the_url_host() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![a.clone(), b.clone()]);
    let next = set_pane_browser(&root, b.id(), "https://example.com/path?q=1", None);
    let pane = found(&next, b.id());
    assert_eq!(pane.kind, SurfaceKind::Browser);
    assert_eq!(pane.url.as_deref(), Some("https://example.com/path?q=1"));
    assert_eq!(pane.title, "example.com");
    assert_eq!(found(&next, a.id()).kind, SurfaceKind::Terminal);
}

#[test]
fn falls_back_to_the_raw_string_as_the_title_when_the_url_is_unparseable() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let next = set_pane_browser(&root, root.id(), "about:blank", None);
    let pane = found(&next, root.id());
    assert_eq!(pane.kind, SurfaceKind::Browser);
    assert_eq!(pane.url.as_deref(), Some("about:blank"));
    assert_eq!(pane.title, "about:blank");
}

#[test]
fn set_pane_browser_leaves_a_non_matching_lone_pane_unchanged() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    assert!(set_pane_browser(&root, "ghost", "https://example.com", None).is_same(&root));
}

#[test]
fn saves_the_device_on_a_browser_pane_and_removes_the_field_when_it_goes_off() {
    let mut ids = IdMint::default();
    let root = browser_pane(&mut ids);
    let device = default_device();
    let on = set_pane_browser_device(&root, root.id(), Some(&device));
    assert_eq!(found(&on, root.id()).browser_device, Some(device.clone()));
    let turned = set_pane_browser_device(&on, root.id(), Some(&rotated(&device)));
    let turned_device = found(&turned, root.id()).browser_device.clone().unwrap();
    assert_eq!(turned_device.width, 800);
    assert_eq!(turned_device.height, 400);
    let off = set_pane_browser_device(&turned, root.id(), None);
    assert_eq!(found(&off, root.id()).browser_device, None);
}

#[test]
fn returns_the_same_tree_when_nothing_changes_or_the_pane_is_not_a_browser() {
    let mut ids = IdMint::default();
    let root = browser_pane(&mut ids);
    let device = default_device();
    assert!(set_pane_browser_device(&root, root.id(), None).is_same(&root));
    let on = set_pane_browser_device(&root, root.id(), Some(&device));
    assert!(set_pane_browser_device(&on, root.id(), Some(&device.clone())).is_same(&on));
    let term = terminal(&mut ids);
    assert!(set_pane_browser_device(&term, term.id(), Some(&device)).is_same(&term));
}

#[test]
fn turns_the_pane_into_a_diff_surface_dropping_fields_of_its_previous_surface() {
    let mut ids = IdMint::default();
    let mut editor = create_pane(&mut ids, SurfaceKind::Editor, Some("a.ts"), Some("/p"));
    editor.file_path = Some("/p/a.ts".to_owned());
    let editor_id = editor.id.clone();
    let editor: LayoutNode = editor.into();
    let other = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![editor, other.clone()]);
    let next = set_pane_diff(&root, &editor_id, "a.ts (diff)", Some("/repo"));
    let mut expected = PaneNode::new(editor_id.clone(), "a.ts (diff)", SurfaceKind::Diff);
    expected.cwd = Some("/repo".to_owned());
    assert_eq!(*found(&next, &editor_id), expected);
    assert!(child(&next, 1).is_same(&other));
}

#[test]
fn set_pane_locked_marks_and_clears_a_pane_returning_the_same_tree_when_nothing_changes() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let a_id = a.id().to_owned();
    let root: LayoutNode = tabs_of(&mut ids, &a_id, vec![tab(&a), tab(&b)]).into();
    assert!(!has_locked_pane(&root));
    let locked = set_pane_locked(&root, b.id(), true);
    assert!(found(&locked, b.id()).locked);
    assert!(has_locked_pane(&locked));
    assert!(set_pane_locked(&locked, b.id(), true).is_same(&locked));
    let open = set_pane_locked(&locked, b.id(), false);
    assert!(!found(&open, b.id()).locked);
    assert!(!has_locked_pane(&open));
}

#[test]
fn set_pane_keep_awake_marks_and_clears_a_pane_returning_the_same_tree_when_nothing_changes() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let kept = set_pane_keep_awake(&root, root.id(), true);
    assert!(found(&kept, root.id()).keep_awake);
    assert!(set_pane_keep_awake(&kept, root.id(), true).is_same(&kept));
    let open = set_pane_keep_awake(&kept, root.id(), false);
    assert!(!found(&open, root.id()).keep_awake);
    assert!(set_pane_keep_awake(&open, root.id(), false).is_same(&open));
}

#[test]
fn stays_when_the_same_agent_stores_a_new_session_and_drops_when_another_agent_starts() {
    let mut ids = IdMint::default();
    let root = edited(&mut ids, |pane| {
        pane.resume = Some(stored(ResumableAgent::Claude, "a", None));
    });
    let kept = set_pane_keep_awake(&root, root.id(), true);
    let same_agent = set_pane_resume(&kept, root.id(), &stored(ResumableAgent::Claude, "b", None));
    let same_pane = found(&same_agent, root.id());
    assert!(same_pane.keep_awake);
    assert_eq!(same_pane.resume.as_ref().unwrap().resume.id, "b");
    let other_agent = set_pane_resume(&kept, root.id(), &stored(ResumableAgent::Codex, "c", None));
    let other_pane = found(&other_agent, root.id());
    assert!(!other_pane.keep_awake);
    let resume = &other_pane.resume.as_ref().unwrap().resume;
    assert_eq!(resume.agent, ResumableAgent::Codex);
    assert_eq!(resume.id, "c");
}

#[test]
fn set_pane_hibernated_marks_and_clears_a_pane_returning_the_same_tree_when_nothing_changes() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let asleep = set_pane_hibernated(&root, root.id(), true);
    assert!(found(&asleep, root.id()).hibernated);
    assert!(set_pane_hibernated(&asleep, root.id(), true).is_same(&asleep));
    let awake = set_pane_hibernated(&asleep, root.id(), false);
    assert!(!found(&awake, root.id()).hibernated);
    assert!(set_pane_hibernated(&awake, root.id(), false).is_same(&awake));
}

#[test]
fn drops_keep_awake_when_the_pane_hibernates() {
    let mut ids = IdMint::default();
    let root = edited(&mut ids, |pane| {
        pane.resume = Some(stored(ResumableAgent::Claude, "a", None));
    });
    let kept = set_pane_keep_awake(&root, root.id(), true);
    let asleep = set_pane_hibernated(&kept, root.id(), true);
    let pane = found(&asleep, root.id());
    assert!(pane.hibernated);
    assert!(!pane.keep_awake);
}

#[test]
fn wakes_a_pane_whose_token_names_a_folder_with_the_next_shell_starting_there() {
    let mut ids = IdMint::default();
    let root = edited(&mut ids, |pane| {
        pane.cwd = Some("/w".to_owned());
        pane.resume = Some(stored(ResumableAgent::Claude, "a", Some("/w/t")));
    });
    let asleep = set_pane_hibernated(&root, root.id(), true);
    let awake = set_pane_hibernated(&asleep, root.id(), false);
    let pane = found(&awake, root.id());
    assert_eq!(pane.cwd.as_deref(), Some("/w"));
    assert_eq!(pane.spawn_dir.as_deref(), Some("/w/t"));
}

#[test]
fn wakes_in_the_folder_the_session_moved_to_after_the_token_was_refreshed() {
    let mut ids = IdMint::default();
    let root = edited(&mut ids, |pane| {
        pane.cwd = Some("/w".to_owned());
        pane.resume = Some(stored(ResumableAgent::Claude, "a", Some("/w/t")));
    });
    let moved = set_pane_resume(
        &root,
        root.id(),
        &stored(ResumableAgent::Claude, "a", Some("/w/t/wt1")),
    );
    let asleep = set_pane_hibernated(&moved, root.id(), true);
    let awake = set_pane_hibernated(&asleep, root.id(), false);
    let pane = found(&awake, root.id());
    assert_eq!(
        pane.resume.as_ref().unwrap().resume.cwd.as_deref(),
        Some("/w/t/wt1")
    );
    assert_eq!(pane.spawn_dir.as_deref(), Some("/w/t/wt1"));
}

#[test]
fn starts_a_pane_in_a_given_folder_the_same_object_when_it_already_is() {
    let mut ids = IdMint::default();
    let root = terminal(&mut ids);
    let placed = set_pane_spawn_dir(&root, root.id(), "/w/t");
    assert_eq!(found(&placed, root.id()).spawn_dir.as_deref(), Some("/w/t"));
    assert!(set_pane_spawn_dir(&placed, root.id(), "/w/t").is_same(&placed));
}

#[test]
fn drops_the_spawn_folder_once_the_shell_started_keeping_it_as_missing_only_when_it_was_gone() {
    let mut ids = IdMint::default();
    let root = edited(&mut ids, |pane| pane.spawn_dir = Some("/w/t".to_owned()));
    let started = settle_spawn_dir(&root, root.id(), false);
    assert_eq!(found(&started, root.id()).spawn_dir, None);
    let gone = settle_spawn_dir(&root, root.id(), true);
    let gone_pane = found(&gone, root.id());
    assert_eq!(gone_pane.spawn_dir, None);
    assert_eq!(gone_pane.resume_folder_missing.as_deref(), Some("/w/t"));
    assert!(settle_spawn_dir(&gone, root.id(), true).is_same(&gone));
}

#[test]
fn clears_the_missing_folder_when_the_shell_reports_that_folder_again() {
    let mut ids = IdMint::default();
    let root = edited(&mut ids, |pane| {
        pane.resume_folder_missing = Some("/w/t".to_owned());
    });
    let elsewhere = set_pane_cwd(&root, root.id(), "/home");
    assert_eq!(
        found(&elsewhere, root.id())
            .resume_folder_missing
            .as_deref(),
        Some("/w/t")
    );
    let back = set_pane_cwd(&root, root.id(), "/w/t");
    assert_eq!(found(&back, root.id()).resume_folder_missing, None);
}

#[test]
fn points_editors_at_a_renamed_file_and_at_files_under_a_moved_folder() {
    let mut ids = IdMint::default();
    let mut editor = |path: &str, title: &str| -> LayoutNode {
        let mut pane = create_pane(&mut ids, SurfaceKind::Editor, None, None);
        pane.file_path = Some(path.to_owned());
        pane.title = title.to_owned();
        pane.into()
    };
    let file = editor("/p/notes.md", "notes.md");
    let nested = editor("/p/src/main.ts", "main.ts");
    let other = editor("/p/srcx/a.ts", "a.ts");
    let inner = split(
        &mut ids,
        Direction::Vertical,
        vec![nested.clone(), other.clone()],
    );
    let root = split(&mut ids, Direction::Horizontal, vec![file.clone(), inner]);

    let renamed = follow_moved_file(&root, "/p/notes.md", "/p/readme.md");
    let renamed_pane = found(&renamed, file.id());
    assert_eq!(renamed_pane.file_path.as_deref(), Some("/p/readme.md"));
    assert_eq!(renamed_pane.title, "readme.md");

    let moved = follow_moved_file(&root, "/p/src", "/p/lib");
    assert_eq!(
        found(&moved, nested.id()).file_path.as_deref(),
        Some("/p/lib/main.ts")
    );
    assert_eq!(
        found(&moved, other.id()).file_path.as_deref(),
        Some("/p/srcx/a.ts")
    );
}

#[test]
fn returns_the_same_tree_when_no_editor_shows_the_moved_path() {
    let mut ids = IdMint::default();
    let a = terminal(&mut ids);
    let b = terminal(&mut ids);
    let root = split(&mut ids, Direction::Horizontal, vec![a, b]);
    assert!(follow_moved_file(&root, "/p/a", "/p/b").is_same(&root));
}
