#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ostia_base::host::Platform;
use ostia_contract::app_menu::{AppMenuEntry, AppMenuSection, AppMenuSpec};
use ostia_workspaces::app_menu::{
    AppMenuDeps, AppMenuText, MAC_CLOSE_WINDOW_ACCELERATOR, MAC_SETTINGS_ACCELERATOR, MenuHost,
    MenuItem, MenuKind, MenuRole, install_app_menu, linux_app_menu_template, mac_app_menu_template,
};
use serde_json::{Value, json};

fn en() -> AppMenuText {
    AppMenuText {
        about: "About {product}".to_owned(),
        file: "File".to_owned(),
        hide: "Hide {product}".to_owned(),
        quit: "Quit {product}".to_owned(),
        reload_window: "Reload Window".to_owned(),
        settings: "Settings…".to_owned(),
        view: "View".to_owned(),
    }
}

fn zh_hant() -> AppMenuText {
    AppMenuText {
        about: "關於 {product}".to_owned(),
        file: "檔案".to_owned(),
        hide: "隱藏 {product}".to_owned(),
        quit: "結束 {product}".to_owned(),
        reload_window: "重新載入視窗".to_owned(),
        settings: "設定…".to_owned(),
        view: "檢視".to_owned(),
    }
}

#[derive(Default)]
struct FakeHost {
    installed: Mutex<Vec<Vec<MenuItem>>>,
    about: Mutex<Vec<String>>,
}

impl MenuHost for FakeHost {
    fn set_application_menu(&self, items: Vec<MenuItem>) {
        self.installed.lock().unwrap().push(items);
    }

    fn set_about_panel_name(&self, name: &str) {
        self.about.lock().unwrap().push(name.to_owned());
    }
}

impl FakeHost {
    fn installed_count(&self) -> usize {
        self.installed.lock().unwrap().len()
    }
}

#[derive(Clone, Default)]
struct Probe {
    settings: Arc<AtomicUsize>,
    reloads: Arc<AtomicUsize>,
    commands: Arc<Mutex<Vec<String>>>,
}

impl Probe {
    fn settings_count(&self) -> usize {
        self.settings.load(Ordering::SeqCst)
    }

    fn reload_count(&self) -> usize {
        self.reloads.load(Ordering::SeqCst)
    }

    fn command_log(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }
}

fn deps_with(text: AppMenuText, probe: &Probe, run: bool, reload: bool) -> AppMenuDeps {
    let settings = probe.settings.clone();
    let reloads = probe.reloads.clone();
    let commands = probe.commands.clone();
    AppMenuDeps {
        product_name: "Ostia".to_owned(),
        text: Arc::new(move || text.clone()),
        open_settings: Arc::new(move || {
            settings.fetch_add(1, Ordering::SeqCst);
        }),
        run_command: run.then(|| {
            Arc::new(move |command: &str| commands.lock().unwrap().push(command.to_owned()))
                as Arc<dyn Fn(&str) + Send + Sync>
        }),
        reload_window: reload.then(|| {
            Arc::new(move || {
                reloads.fetch_add(1, Ordering::SeqCst);
            }) as Arc<dyn Fn() + Send + Sync>
        }),
    }
}

fn plain_deps(probe: &Probe) -> AppMenuDeps {
    deps_with(en(), probe, false, false)
}

fn flatten(items: &[MenuItem]) -> Vec<&MenuItem> {
    let mut out = Vec::new();
    for item in items {
        out.push(item);
        out.extend(flatten(&item.submenu));
    }
    out
}

fn template() -> Vec<MenuItem> {
    mac_app_menu_template(&plain_deps(&Probe::default()), None)
}

fn command(command: &str, label: &str, accelerator: Option<&str>) -> AppMenuEntry {
    AppMenuEntry::Command {
        command: command.to_owned(),
        label: label.to_owned(),
        accelerator: accelerator.map(str::to_owned),
    }
}

fn section(label: &str, items: Vec<AppMenuEntry>) -> AppMenuSection {
    AppMenuSection {
        label: label.to_owned(),
        items,
    }
}

fn spec() -> AppMenuSpec {
    AppMenuSpec {
        file: section(
            "File",
            vec![
                command("workspace.new", "New Workspace", Some("Cmd+T")),
                AppMenuEntry::Separator,
                command("workspace.save", "Save Workspace", None),
            ],
        ),
        view: section("View", vec![command("pane.zoom", "Zoom Pane", None)]),
        go: section("Go", vec![command("tab.next", "Next Tab", None)]),
        help: section(
            "Help",
            vec![command("developer.openLogFolder", "Open Log Folder", None)],
        ),
    }
}

fn spec_json() -> Value {
    json!({
        "file": {
            "label": "File",
            "items": [
                {"command": "workspace.new", "label": "New Workspace", "accelerator": "Cmd+T"},
                {"separator": true},
                {"command": "workspace.save", "label": "Save Workspace"}
            ]
        },
        "view": {"label": "View", "items": [{"command": "pane.zoom", "label": "Zoom Pane"}]},
        "go": {"label": "Go", "items": [{"command": "tab.next", "label": "Next Tab"}]},
        "help": {
            "label": "Help",
            "items": [{"command": "developer.openLogFolder", "label": "Open Log Folder"}]
        }
    })
}

fn view_spec() -> AppMenuSpec {
    AppMenuSpec {
        file: section("File", vec![]),
        view: section(
            "View",
            vec![command("window.reload", "Reload Window", None)],
        ),
        go: section("Go", vec![]),
        help: section("Help", vec![]),
    }
}

fn roles(items: &[MenuItem]) -> Vec<Option<MenuRole>> {
    flatten(items).iter().map(|item| item.role).collect()
}

fn accelerators(items: &[MenuItem]) -> Vec<String> {
    flatten(items)
        .iter()
        .filter_map(|item| item.accelerator.clone())
        .collect()
}

fn by_id<'a>(items: &'a [MenuItem], id: &str) -> Option<&'a MenuItem> {
    flatten(items)
        .into_iter()
        .find(|item| item.id.as_deref() == Some(id))
}

#[test]
fn leaves_cmd_w_to_the_renderer_where_it_closes_the_pane_and_closes_the_window_with_cmd_shift_w() {
    let template = template();
    let accelerators = accelerators(&template);
    assert!(!accelerators.contains(&"Cmd+W".to_owned()));
    assert!(!accelerators.contains(&"CmdOrCtrl+W".to_owned()));
    let close = flatten(&template)
        .into_iter()
        .find(|item| item.role == Some(MenuRole::Close))
        .unwrap();
    assert_eq!(
        close.accelerator.as_deref(),
        Some(MAC_CLOSE_WINDOW_ACCELERATOR)
    );
    assert_eq!(MAC_CLOSE_WINDOW_ACCELERATOR, "Cmd+Shift+W");
}

#[test]
fn names_the_app_menu_and_its_about_hide_and_quit_items_after_the_product_not_the_package_name() {
    let template = template();
    let app_menu = &template[0];
    assert_eq!(app_menu.label.as_deref(), Some("Ostia"));
    let labels: Vec<String> = flatten(&template[..1])
        .iter()
        .map(|item| item.label.clone().unwrap_or_default())
        .collect();
    assert!(labels.contains(&"About Ostia".to_owned()));
    assert!(labels.contains(&"Hide Ostia".to_owned()));
    assert!(labels.contains(&"Quit Ostia".to_owned()));
    assert!(!labels.join(" ").to_lowercase().contains("pine"));
}

#[test]
fn offers_settings_with_cmd_comma_in_the_app_menu_shown_but_left_to_the_renderer_so_it_fires_once()
{
    let probe = Probe::default();
    let template = mac_app_menu_template(&plain_deps(&probe), None);
    let settings = by_id(&template, "settings").unwrap();
    assert_eq!(settings.label.as_deref(), Some("Settings…"));
    assert_eq!(
        settings.accelerator.as_deref(),
        Some(MAC_SETTINGS_ACCELERATOR)
    );
    assert_eq!(MAC_SETTINGS_ACCELERATOR, "Cmd+,");
    assert!(!settings.register_accelerator);
    settings.click();
    assert_eq!(probe.settings_count(), 1);
}

#[test]
fn has_no_reload_or_force_reload_so_cmd_r_and_cmd_shift_r_cannot_reload_the_window() {
    let template = template();
    let roles = roles(&template);
    assert!(!roles.contains(&Some(MenuRole::Reload)));
    assert!(!roles.contains(&Some(MenuRole::ForceReload)));
    assert!(!roles.contains(&Some(MenuRole::ViewMenu)));
    assert!(roles.contains(&Some(MenuRole::ToggleFullscreen)));
    assert!(roles.contains(&Some(MenuRole::ToggleDevTools)));
}

#[test]
fn keeps_the_standard_edit_and_window_menus_that_text_fields_and_the_browser_pane_rely_on() {
    let roles: Vec<Option<MenuRole>> = template().iter().map(|item| item.role).collect();
    assert!(roles.contains(&Some(MenuRole::EditMenu)));
    assert!(roles.contains(&Some(MenuRole::WindowMenu)));
}

mod with_the_renderer_menu_spec {
    use super::*;

    fn with_spec(probe: &Probe) -> Vec<MenuItem> {
        mac_app_menu_template(&deps_with(en(), probe, true, false), Some(&spec()))
    }

    #[test]
    fn shows_the_shortcut_but_leaves_it_to_the_renderer_and_runs_the_command_on_click() {
        let probe = Probe::default();
        let template = with_spec(&probe);
        let item = by_id(&template, "command:workspace.new").unwrap();
        assert_eq!(item.label.as_deref(), Some("New Workspace"));
        assert_eq!(item.accelerator.as_deref(), Some("Cmd+T"));
        assert!(!item.register_accelerator);
        item.click();
        assert_eq!(probe.command_log(), vec!["workspace.new".to_owned()]);
    }

    #[test]
    fn adds_go_and_help_menus_and_keeps_close_window_full_screen_and_the_system_menus() {
        let probe = Probe::default();
        let template = with_spec(&probe);
        let names: Vec<String> = template
            .iter()
            .map(|menu| match (&menu.label, menu.role) {
                (Some(label), _) => label.clone(),
                (None, Some(role)) => format!("{role:?}"),
                (None, None) => String::new(),
            })
            .collect();
        assert_eq!(
            names,
            vec![
                "Ostia",
                "File",
                "EditMenu",
                "View",
                "Go",
                "WindowMenu",
                "Help"
            ]
        );
        let file = &template[1].submenu;
        assert_eq!(file.last().unwrap().role, Some(MenuRole::Close));
        assert_eq!(file[file.len() - 2].kind, MenuKind::Separator);
        assert!(roles(&template).contains(&Some(MenuRole::ToggleFullscreen)));
        let help = template
            .iter()
            .find(|menu| menu.label.as_deref() == Some("Help"))
            .unwrap();
        assert_eq!(help.role, Some(MenuRole::Help));
    }

    #[test]
    fn still_leaves_cmd_w_to_the_renderer() {
        let probe = Probe::default();
        let template = with_spec(&probe);
        assert!(!accelerators(&template).contains(&"Cmd+W".to_owned()));
    }

    #[test]
    fn rebuilds_the_installed_menu_only_for_a_valid_spec() {
        let probe = Probe::default();
        let host = Arc::new(FakeHost::default());
        let menu = install_app_menu(
            Platform::Darwin,
            deps_with(en(), &probe, true, false),
            host.clone(),
        );
        assert_eq!(host.installed_count(), 1);
        assert!(!menu.set_spec(&json!({"file": "nope"})));
        assert_eq!(host.installed_count(), 1);
        assert!(menu.set_spec(&spec_json()));
        assert_eq!(host.installed_count(), 2);
        assert!(menu.set_spec(&spec_json()));
        assert_eq!(host.installed_count(), 2);
        let linux_host = Arc::new(FakeHost::default());
        let linux = install_app_menu(
            Platform::Linux,
            deps_with(en(), &probe, false, false),
            linux_host,
        );
        assert!(!linux.set_spec(&spec_json()));
    }
}

mod reload_window {
    use super::*;

    #[test]
    fn sits_in_the_view_menu_without_a_shortcut_and_runs_in_main_without_asking_the_renderer() {
        let probe = Probe::default();
        let template =
            mac_app_menu_template(&deps_with(en(), &probe, true, true), Some(&view_spec()));
        let view = template
            .iter()
            .find(|menu| menu.label.as_deref() == Some("View"))
            .unwrap();
        let item = by_id(&view.submenu, "command:window.reload").unwrap();
        assert_eq!(item.label.as_deref(), Some("Reload Window"));
        assert_eq!(item.accelerator, None);
        item.click();
        assert_eq!(probe.reload_count(), 1);
        assert!(probe.command_log().is_empty());
    }

    #[test]
    fn adds_no_reload_or_force_reload_role_and_no_cmd_r_to_the_menu() {
        let probe = Probe::default();
        let template =
            mac_app_menu_template(&deps_with(en(), &probe, false, true), Some(&view_spec()));
        let roles = roles(&template);
        assert!(!roles.contains(&Some(MenuRole::Reload)));
        assert!(!roles.contains(&Some(MenuRole::ForceReload)));
        assert!(!accelerators(&template).contains(&"Cmd+R".to_owned()));
    }

    #[test]
    fn is_in_the_linux_view_menu_too_with_no_shortcut() {
        let probe = Probe::default();
        let template = linux_app_menu_template(&deps_with(en(), &probe, false, true));
        let item = by_id(&template, "command:window.reload").unwrap();
        assert_eq!(item.label.as_deref(), Some("Reload Window"));
        assert_eq!(item.accelerator, None);
        item.click();
        assert_eq!(probe.reload_count(), 1);
    }
}

#[test]
fn labels_its_own_items_in_the_language_the_app_shows() {
    let probe = Probe::default();
    let template = mac_app_menu_template(&deps_with(zh_hant(), &probe, false, false), None);
    let t = zh_hant();
    let labels: Vec<String> = flatten(&template)
        .iter()
        .filter_map(|item| item.label.clone())
        .filter(|label| !label.is_empty())
        .collect();
    assert_eq!(
        labels,
        vec![
            "Ostia".to_owned(),
            t.about.replace("{product}", "Ostia"),
            t.settings.clone(),
            t.hide.replace("{product}", "Ostia"),
            t.quit.replace("{product}", "Ostia"),
            t.file.clone(),
            t.view.clone(),
        ]
    );
}

#[test]
fn installs_the_menu_and_the_about_panel_name_on_macos_only() {
    let probe = Probe::default();
    let host = Arc::new(FakeHost::default());
    let _menu = install_app_menu(Platform::Darwin, plain_deps(&probe), host.clone());
    assert_eq!(host.installed_count(), 1);
    assert!(!host.installed.lock().unwrap()[0].is_empty());
    assert_eq!(*host.about.lock().unwrap(), vec!["Ostia".to_owned()]);
}

#[test]
fn replaces_the_default_electron_menu_on_linux_and_windows_with_one_that_has_no_reload_quit_or_zoom()
 {
    let probe = Probe::default();
    let host = Arc::new(FakeHost::default());
    let _menu = install_app_menu(Platform::Linux, plain_deps(&probe), host.clone());
    assert_eq!(host.installed_count(), 1);
    assert!(host.about.lock().unwrap().is_empty());
    let template = linux_app_menu_template(&plain_deps(&probe));
    let roles: Vec<MenuRole> = flatten(&template)
        .iter()
        .filter_map(|item| item.role)
        .collect();
    assert_eq!(
        roles,
        vec![MenuRole::ToggleFullscreen, MenuRole::ToggleDevTools]
    );
}
