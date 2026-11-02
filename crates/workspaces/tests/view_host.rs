#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ostia_contract::view_parse::{ViewParseResult, parse_view_text};
use ostia_contract::views::{
    VIEW_FILE_MAX_BYTES, VIEW_FILES_MAX, ViewIcon, ViewNodeType, ViewPlacement, ViewProblem,
};
use ostia_workspaces::view_host::{
    ViewHost, ViewHostDeps, ViewInfo, ViewListing, ViewRecord, ViewStatus, ViewStore,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::mpsc::UnboundedReceiver;

fn view() -> Value {
    json!({
        "version": 1,
        "title": "Workspaces",
        "placement": "sidebar",
        "root": {
            "type": "list",
            "for": "workspaces",
            "as": "ws",
            "item": {"type": "text", "text": "{{ws.name}}"}
        }
    })
}

fn view_with(key: &str, value: Value) -> Value {
    let mut doc = view();
    doc[key] = value;
    doc
}

struct Rig {
    _base: TempDir,
    dir: PathBuf,
    store_path: PathBuf,
    changes: Option<UnboundedReceiver<ViewListing>>,
    host: Option<ViewHost>,
    log: Arc<Mutex<Vec<String>>>,
}

impl Rig {
    fn new() -> Self {
        let base = TempDir::new().unwrap();
        let dir = base.path().join("views");
        fs::create_dir(&dir).unwrap();
        let store_path = base.path().join("views.json");
        Self {
            _base: base,
            dir,
            store_path,
            changes: None,
            host: None,
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn write(&self, name: &str, body: &Value) {
        fs::write(
            self.dir.join(name),
            serde_json::to_string_pretty(body).unwrap(),
        )
        .unwrap();
    }

    fn write_text(&self, name: &str, text: &str) {
        fs::write(self.dir.join(name), text).unwrap();
    }

    fn start(&mut self) -> &ViewHost {
        let log = Arc::clone(&self.log);
        let host = ViewHost::new(ViewHostDeps {
            dir: self.dir.clone(),
            store: ViewStore::new(self.store_path.clone()),
            log: Some(Arc::new(move |line| log.lock().push(line.to_owned()))),
        });
        self.changes = Some(host.subscribe());
        self.host.insert(host)
    }

    fn host(&self) -> &ViewHost {
        self.host.as_ref().unwrap()
    }

    fn info(&self, name: &str) -> Option<ViewInfo> {
        self.host().list().into_iter().find(|v| v.name == name)
    }

    fn changes(&mut self) -> Vec<ViewListing> {
        let receiver = self.changes.as_mut().unwrap();
        let mut seen = Vec::new();
        while let Ok(listing) = receiver.try_recv() {
            seen.push(listing);
        }
        seen
    }

    fn store_json(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(&self.store_path).unwrap()).unwrap()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(host) = &self.host {
            host.stop();
        }
    }
}

async fn settle_watcher() {
    let wait = if cfg!(target_os = "macos") { 600 } else { 0 };
    tokio::time::sleep(Duration::from_millis(wait)).await;
}

async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..250 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting until {what}");
}

fn names(host: &ViewHost) -> Vec<String> {
    host.list().into_iter().map(|v| v.name).collect()
}

fn problem(path: &str, message: &str) -> ViewProblem {
    ViewProblem {
        path: path.to_owned(),
        line: None,
        message: message.to_owned(),
    }
}

fn root_type(info: &ViewInfo) -> Option<ViewNodeType> {
    info.doc.as_ref().map(|doc| doc.root.node_type())
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

#[test]
fn lists_a_new_view_as_pending_and_hides_its_tree_until_enabled() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start();
    let pending = rig.info("agents").unwrap();
    assert_eq!(pending.status, ViewStatus::Pending);
    assert_eq!(pending.title, "Workspaces");
    assert_eq!(pending.placement, Some(ViewPlacement::Sidebar));
    assert!(pending.doc.is_none());
    assert_eq!(pending.problems, Vec::<ViewProblem>::new());

    rig.host().set_enabled("agents", true).unwrap();
    let enabled = rig.info("agents").unwrap();
    assert_eq!(enabled.status, ViewStatus::Enabled);
    assert_eq!(root_type(&enabled), Some(ViewNodeType::List));
    assert_eq!(rig.store_json(), json!({"agents": {"enabled": true}}));
    assert_eq!(
        rig.changes().last().unwrap().views[0].status,
        ViewStatus::Enabled
    );
}

#[test]
fn remembers_enablement_across_restarts_and_never_enables_a_file_it_does_not_list() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start().set_enabled("agents", true).unwrap();
    rig.host().set_enabled("ghost", true).unwrap();
    rig.host().stop();
    rig.start();
    assert_eq!(rig.info("agents").unwrap().status, ViewStatus::Enabled);
    assert!(rig.store_json().get("ghost").is_none());
}

#[test]
fn refuses_symbolic_links() {
    let mut rig = Rig::new();
    rig.write("real.txt", &view());
    symlink(rig.dir.join("real.txt"), rig.dir.join("linked.json")).unwrap();
    rig.start();
    let linked = rig.info("linked").unwrap();
    assert!(linked.doc.is_none());
    assert_eq!(linked.placement, None);
    assert_eq!(
        linked.problems,
        vec![problem("(file)", "symbolic links are not read")]
    );
}

#[test]
fn refuses_files_over_the_size_cap() {
    let mut rig = Rig::new();
    let mut big = view_with("description", json!("x".repeat(10)));
    big["pad"] = json!(" ".repeat(VIEW_FILE_MAX_BYTES));
    rig.write("big.json", &big);
    rig.start();
    let message = rig.info("big").unwrap().problems[0].message.clone();
    assert!(message.contains("larger than 64 KiB"), "{message}");
}

#[test]
fn ignores_files_whose_names_are_not_view_names() {
    let mut rig = Rig::new();
    rig.write("Agents.json", &view());
    rig.write_text("notes.txt", "hi");
    rig.write(".hidden.json", &view());
    rig.start();
    assert!(rig.host().list().is_empty());
}

#[test]
fn keeps_the_last_good_tree_when_an_enabled_view_breaks_and_reports_the_problem() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start().set_enabled("agents", true).unwrap();
    rig.write(
        "agents.json",
        &json!({
            "version": 1,
            "title": "Workspaces",
            "placement": "sidebar",
            "root": {"type": "text", "text": "{{nope}}"}
        }),
    );
    rig.host().rescan();
    let broken = rig.info("agents").unwrap();
    assert!(broken.stale);
    assert_eq!(root_type(&broken), Some(ViewNodeType::List));
    assert_eq!(broken.problems[0].path, "root.text");
    assert_eq!(broken.problems[0].line, Some(7));
}

#[tokio::test(flavor = "multi_thread")]
async fn reloads_on_its_own_when_a_file_is_added_changed_or_removed() {
    let mut rig = Rig::new();
    rig.start().watch();
    settle_watcher().await;
    rig.write("agents.json", &view());
    wait_until("the file is listed", || rig.info("agents").is_some()).await;
    rig.write("agents.json", &view_with("title", json!("Renamed")));
    wait_until("the title changed", || {
        rig.info("agents").unwrap().title == "Renamed"
    })
    .await;
    fs::remove_file(rig.dir.join("agents.json")).unwrap();
    wait_until("the file is gone", || rig.info("agents").is_none()).await;
    assert!(rig.changes().len() >= 3);
}

#[test]
fn a_view_file_shows_in_the_sidebar_only_after_the_human_enables_it_with_live_data_and_working_buttons()
 {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start();
    let listed = rig.host().listing();
    assert_eq!(listed.views.len(), 1);
    assert_eq!(listed.views[0].name, "agents");
    assert_eq!(listed.views[0].status, ViewStatus::Pending);
    assert!(listed.views[0].doc.is_none());
    let enabled = rig.host().set_enabled("agents", true).unwrap();
    assert_eq!(enabled.views.len(), 1);
    assert_eq!(enabled.views[0].name, "agents");
    assert_eq!(enabled.views[0].status, ViewStatus::Enabled);
    assert_eq!(root_type(&enabled.views[0]), Some(ViewNodeType::List));
    assert_eq!(rig.changes().last(), Some(&enabled));
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_the_views_folder_when_it_does_not_exist_yet() {
    let mut rig = Rig::new();
    fs::remove_dir_all(&rig.dir).unwrap();
    rig.start().watch();
    settle_watcher().await;
    rig.write("late.json", &view());
    wait_until("the late file is listed", || rig.info("late").is_some()).await;
}

#[test]
fn teaches_a_view_example_that_validates() {
    let section = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/main/agents/skills/ostia/reference/views.md"),
    )
    .unwrap();
    let start = section.find("```json\n").map(|at| at + "```json\n".len());
    let example = start.and_then(|from| {
        section[from..]
            .find("```")
            .map(|length| &section[from..from + length])
    });
    let example = example.unwrap();
    let problems = match parse_view_text(example) {
        ViewParseResult::Ok(_) => Vec::new(),
        ViewParseResult::Failed(problems) => problems,
    };
    assert_eq!(problems, Vec::<ViewProblem>::new());
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("views.json");
    fs::copy(fixture("views-before.json"), &file).unwrap();
    let store = ViewStore::new(file.clone());
    assert_eq!(store.get("agents"), Some(ViewRecord { enabled: true }));
    assert_eq!(store.get("notes"), Some(ViewRecord { enabled: false }));
    store.set("agents", ViewRecord { enabled: false }).unwrap();
    store.set("late", ViewRecord { enabled: true }).unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("views-after.json")).unwrap()
    );
}

#[test]
fn the_store_drops_entries_whose_name_is_not_a_view_name_or_whose_value_is_not_an_object() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("views.json");
    fs::write(
        &file,
        json!({
            "agents": {"enabled": true},
            "Upper": {"enabled": true},
            "-lead": {"enabled": true},
            "text": "yes",
            "number": 1,
            "nothing": null,
            "flag": true,
            "list": [],
            "strict": {"enabled": "true"},
            "missing": {},
            "constructor": {"enabled": true}
        })
        .to_string(),
    )
    .unwrap();
    let store = ViewStore::new(file);
    let rows = [
        ("agents", Some(true)),
        ("Upper", None),
        ("-lead", None),
        ("text", None),
        ("number", None),
        ("nothing", None),
        ("flag", None),
        ("list", Some(false)),
        ("strict", Some(false)),
        ("missing", Some(false)),
        ("constructor", Some(true)),
        ("absent", None),
        ("toString", None),
    ];
    for (name, expected) in rows {
        assert_eq!(
            store.get(name).map(|record| record.enabled),
            expected,
            "{name}"
        );
    }
}

#[test]
fn the_store_starts_empty_when_the_file_is_missing_or_is_not_an_object() {
    let dir = TempDir::new().unwrap();
    let missing = ViewStore::new(dir.path().join("none.json"));
    assert_eq!(missing.get("agents"), None);
    for (index, text) in ["[1]", "\"x\"", "7", "null", "{broken"].iter().enumerate() {
        let file = dir.path().join(format!("bad{index}.json"));
        fs::write(&file, text).unwrap();
        assert_eq!(ViewStore::new(file).get("agents"), None, "{text}");
    }
}

#[test]
fn the_store_set_keeps_the_place_of_an_existing_name_and_adds_a_new_name_last() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("views.json");
    let store = ViewStore::new(file.clone());
    store.set("b", ViewRecord { enabled: true }).unwrap();
    store.set("a", ViewRecord { enabled: true }).unwrap();
    store.set("b", ViewRecord { enabled: false }).unwrap();
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.find("\"b\"").unwrap() < text.find("\"a\"").unwrap(),
        "{text}"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({"b": {"enabled": false}, "a": {"enabled": true}})
    );
}

#[test]
fn the_store_set_reports_a_save_that_fails() {
    let dir = TempDir::new().unwrap();
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, "file").unwrap();
    let store = ViewStore::new(blocker.join("views.json"));
    assert!(store.set("agents", ViewRecord { enabled: true }).is_err());
}

#[test]
fn lists_views_in_file_name_order_with_the_title_as_the_name_when_the_file_has_no_doc() {
    let mut rig = Rig::new();
    rig.write("zeta.json", &view());
    rig.write("alpha.json", &view());
    rig.write_text("broken.json", "{not json");
    rig.start();
    assert_eq!(names(rig.host()), vec!["alpha", "broken", "zeta"]);
    let broken = rig.info("broken").unwrap();
    assert_eq!(broken.title, "broken");
    assert_eq!(broken.placement, None);
    assert!(broken.doc.is_none());
    assert!(!broken.stale);
    assert_eq!(broken.file, rig.dir.join("broken.json"));
    assert_eq!(broken.problems[0].path, "(document)");
}

#[test]
fn shows_a_disabled_view_with_its_title_and_without_its_tree() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start().set_enabled("agents", true).unwrap();
    rig.host().set_enabled("agents", false).unwrap();
    let info = rig.info("agents").unwrap();
    assert_eq!(info.status, ViewStatus::Disabled);
    assert_eq!(info.title, "Workspaces");
    assert!(info.doc.is_none());
    assert_eq!(rig.store_json(), json!({"agents": {"enabled": false}}));
}

#[test]
fn carries_the_icon_and_the_description_only_when_the_doc_has_them() {
    let mut rig = Rig::new();
    let mut full = view_with("icon", json!("rocket"));
    full["description"] = json!("Shows every workspace");
    rig.write("full.json", &full);
    rig.write("plain.json", &view());
    rig.start();
    let full = rig.info("full").unwrap();
    assert_eq!(full.icon, Some(ViewIcon::Rocket));
    assert_eq!(full.description.as_deref(), Some("Shows every workspace"));
    let plain = rig.info("plain").unwrap();
    assert_eq!(plain.icon, None);
    assert_eq!(plain.description, None);
}

#[test]
fn keeps_the_icon_and_title_of_the_last_good_doc_while_the_file_is_broken() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view_with("icon", json!("rocket")));
    rig.start();
    rig.write_text("agents.json", "{broken");
    rig.host().rescan();
    let broken = rig.info("agents").unwrap();
    assert!(broken.stale);
    assert_eq!(broken.title, "Workspaces");
    assert_eq!(broken.placement, Some(ViewPlacement::Sidebar));
    assert_eq!(broken.icon, Some(ViewIcon::Rocket));
    assert!(broken.doc.is_none());
}

#[test]
fn forgets_the_last_good_doc_when_the_file_is_removed() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start();
    fs::remove_file(rig.dir.join("agents.json")).unwrap();
    rig.host().rescan();
    assert!(rig.info("agents").is_none());
    rig.write_text("agents.json", "{broken");
    rig.host().rescan();
    let again = rig.info("agents").unwrap();
    assert!(!again.stale);
    assert_eq!(again.title, "agents");
}

#[test]
fn rescan_tells_listeners_only_when_the_listing_changed() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start();
    rig.host().rescan();
    assert!(rig.changes().is_empty());
    rig.write("agents.json", &view_with("title", json!("Renamed")));
    rig.host().rescan();
    let seen = rig.changes();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].views[0].title, "Renamed");
    assert_eq!(seen[0].dir, rig.dir);
    rig.host().rescan();
    assert!(rig.changes().is_empty());
}

#[test]
fn scan_says_whether_the_listing_changed() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start();
    assert!(!rig.host().scan());
    rig.write("more.json", &view());
    assert!(rig.host().scan());
    assert!(!rig.host().scan());
}

#[test]
fn setting_enablement_on_an_unknown_name_writes_nothing_and_tells_no_one() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start();
    let listing = rig.host().set_enabled("ghost", true).unwrap();
    assert_eq!(listing, rig.host().listing());
    assert!(!rig.store_path.exists());
    assert!(rig.changes().is_empty());
}

#[test]
fn setting_enablement_does_not_tell_listeners_when_the_save_fails() {
    let mut rig = Rig::new();
    let blocker = rig.dir.parent().unwrap().join("blocker");
    fs::write(&blocker, "file").unwrap();
    rig.store_path = blocker.join("views.json");
    rig.write("agents.json", &view());
    rig.start();
    assert!(rig.host().set_enabled("agents", true).is_err());
    assert!(rig.changes().is_empty());
}

#[test]
fn gives_the_path_of_a_listed_view_and_none_for_an_unknown_one() {
    let mut rig = Rig::new();
    rig.write("agents.json", &view());
    rig.start();
    assert_eq!(
        rig.host().path_of("agents"),
        Some(rig.dir.join("agents.json"))
    );
    assert_eq!(rig.host().path_of("ghost"), None);
    assert!(rig.host().info("ghost").is_none());
}

#[test]
fn refuses_a_name_that_is_a_folder() {
    let mut rig = Rig::new();
    fs::create_dir(rig.dir.join("folder.json")).unwrap();
    rig.start();
    assert_eq!(
        rig.info("folder").unwrap().problems,
        vec![problem("(file)", "not a regular file")]
    );
}

#[test]
fn reads_a_file_of_exactly_the_size_cap() {
    let mut rig = Rig::new();
    let mut text = serde_json::to_string(&view()).unwrap();
    text.push_str(&" ".repeat(VIEW_FILE_MAX_BYTES - text.len()));
    assert_eq!(text.len(), VIEW_FILE_MAX_BYTES);
    rig.write_text("edge.json", &text);
    rig.start();
    assert_eq!(
        rig.info("edge").unwrap().problems,
        Vec::<ViewProblem>::new()
    );
}

#[test]
fn reads_only_the_first_files_over_the_file_count_cap_and_logs_it() {
    let mut rig = Rig::new();
    for index in 0..=VIEW_FILES_MAX {
        rig.write(&format!("v{index:02}.json"), &view());
    }
    rig.write_text("notes.txt", "not a view");
    rig.start();
    assert_eq!(rig.host().list().len(), VIEW_FILES_MAX);
    assert!(rig.info("v49").is_some());
    assert!(rig.info("v50").is_none());
    assert_eq!(
        rig.log.lock().clone(),
        vec![format!(
            "only the first {VIEW_FILES_MAX} view files are read"
        )]
    );
}

#[test]
fn does_not_count_files_that_are_not_view_names_toward_the_cap() {
    let mut rig = Rig::new();
    for index in 0..VIEW_FILES_MAX {
        rig.write(&format!("v{index:02}.json"), &view());
        rig.write_text(&format!("Z{index:02}.json"), "{}");
    }
    rig.start();
    assert_eq!(rig.host().list().len(), VIEW_FILES_MAX);
    assert!(rig.log.lock().is_empty());
}

#[test]
fn lists_nothing_when_the_views_folder_is_missing_or_is_a_symbolic_link() {
    let mut rig = Rig::new();
    let real = rig.dir.parent().unwrap().join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("agents.json"), view().to_string()).unwrap();
    fs::remove_dir_all(&rig.dir).unwrap();
    rig.start();
    assert!(rig.host().list().is_empty());
    symlink(&real, &rig.dir).unwrap();
    rig.host().rescan();
    assert!(rig.host().list().is_empty());
    assert_eq!(rig.host().listing().dir, rig.dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn creates_the_views_folder_private_to_the_user() {
    let mut rig = Rig::new();
    fs::remove_dir_all(&rig.dir).unwrap();
    rig.start().watch();
    let mode = fs::metadata(&rig.dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
}

#[tokio::test(flavor = "multi_thread")]
async fn logs_when_it_cannot_create_the_views_folder() {
    let mut rig = Rig::new();
    let blocker = rig.dir.parent().unwrap().join("blocker");
    fs::write(&blocker, "file").unwrap();
    rig.dir = blocker.join("views");
    rig.start().watch();
    let lines = rig.log.lock().clone();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].starts_with(&format!("cannot create {}: ", rig.dir.display())),
        "{}",
        lines[0]
    );
    assert!(rig.host().list().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn groups_a_burst_of_writes_into_one_change() {
    let mut rig = Rig::new();
    rig.start().watch();
    settle_watcher().await;
    for name in ["a.json", "b.json", "c.json"] {
        rig.write(name, &view());
    }
    wait_until("all three files are listed", || {
        rig.host().list().len() == 3
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(rig.changes().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_ends_the_watch_and_drops_a_pending_rescan() {
    let mut rig = Rig::new();
    rig.start().watch();
    settle_watcher().await;
    rig.write("late.json", &view());
    rig.host().stop();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(rig.host().list().is_empty());
    assert!(rig.changes().is_empty());
    rig.write("later.json", &view());
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(rig.host().list().is_empty());
}
