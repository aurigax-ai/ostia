use std::sync::Arc;

use ostia_base::host::Platform;
use ostia_contract::app_menu::{AppMenuEntry, AppMenuSpec, parse_app_menu_spec};
use parking_lot::Mutex;
use serde_json::Value;

pub const MAC_CLOSE_WINDOW_ACCELERATOR: &str = "Cmd+Shift+W";
pub const MAC_SETTINGS_ACCELERATOR: &str = "Cmd+,";
const RELOAD_WINDOW_COMMAND: &str = "window.reload";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppMenuText {
    pub about: String,
    pub file: String,
    pub hide: String,
    pub quit: String,
    pub reload_window: String,
    pub settings: String,
    pub view: String,
}

#[derive(Clone)]
pub struct AppMenuDeps {
    pub product_name: String,
    pub text: Arc<dyn Fn() -> AppMenuText + Send + Sync>,
    pub open_settings: Arc<dyn Fn() + Send + Sync>,
    pub run_command: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    pub reload_window: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuRole {
    About,
    Services,
    Hide,
    HideOthers,
    Unhide,
    Quit,
    Close,
    EditMenu,
    ViewMenu,
    WindowMenu,
    Help,
    Reload,
    ForceReload,
    ToggleFullscreen,
    ToggleDevTools,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKind {
    Normal,
    Separator,
}

#[derive(Clone)]
pub struct MenuItem {
    pub id: Option<String>,
    pub label: Option<String>,
    pub role: Option<MenuRole>,
    pub kind: MenuKind,
    pub accelerator: Option<String>,
    pub register_accelerator: bool,
    pub submenu: Vec<MenuItem>,
    on_click: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl MenuItem {
    fn blank() -> Self {
        Self {
            id: None,
            label: None,
            role: None,
            kind: MenuKind::Normal,
            accelerator: None,
            register_accelerator: true,
            submenu: Vec::new(),
            on_click: None,
        }
    }

    fn separator() -> Self {
        Self {
            kind: MenuKind::Separator,
            ..Self::blank()
        }
    }

    fn role(role: MenuRole) -> Self {
        Self {
            role: Some(role),
            ..Self::blank()
        }
    }

    fn labelled_role(role: MenuRole, label: String) -> Self {
        Self {
            label: Some(label),
            ..Self::role(role)
        }
    }

    fn menu(label: String, submenu: Vec<MenuItem>) -> Self {
        Self {
            label: Some(label),
            submenu,
            ..Self::blank()
        }
    }

    pub fn click(&self) {
        if let Some(on_click) = &self.on_click {
            on_click();
        }
    }
}

pub trait MenuHost: Send + Sync {
    fn set_application_menu(&self, items: Vec<MenuItem>);
    fn set_about_panel_name(&self, name: &str);
}

fn command_items(
    entries: &[AppMenuEntry],
    run: &Option<Arc<dyn Fn(&str) + Send + Sync>>,
    reload: &Option<Arc<dyn Fn() + Send + Sync>>,
) -> Vec<MenuItem> {
    entries
        .iter()
        .map(|entry| match entry {
            AppMenuEntry::Separator => MenuItem::separator(),
            AppMenuEntry::Command {
                command,
                label,
                accelerator,
            } => {
                let shortcut = accelerator.clone().filter(|key| !key.is_empty());
                let command = command.clone();
                let run = run.clone();
                let reload = reload.clone();
                let on_click: Arc<dyn Fn() + Send + Sync> = Arc::new({
                    let command = command.clone();
                    move || {
                        if command == RELOAD_WINDOW_COMMAND {
                            if let Some(reload) = &reload {
                                reload();
                            }
                        } else if let Some(run) = &run {
                            run(&command);
                        }
                    }
                });
                MenuItem {
                    id: Some(format!("command:{command}")),
                    label: Some(label.clone()),
                    register_accelerator: shortcut.is_none(),
                    accelerator: shortcut,
                    on_click: Some(on_click),
                    ..MenuItem::blank()
                }
            }
        })
        .collect()
}

fn with_trailing_separator(mut items: Vec<MenuItem>) -> Vec<MenuItem> {
    if !items.is_empty() {
        items.push(MenuItem::separator());
    }
    items
}

pub fn mac_app_menu_template(deps: &AppMenuDeps, spec: Option<&AppMenuSpec>) -> Vec<MenuItem> {
    let name = deps.product_name.clone();
    let text = (deps.text)();
    let items = |entries: Option<&[AppMenuEntry]>| {
        entries
            .map(|entries| command_items(entries, &deps.run_command, &deps.reload_window))
            .unwrap_or_default()
    };
    let settings = MenuItem {
        id: Some("settings".to_owned()),
        label: Some(text.settings.clone()),
        accelerator: Some(MAC_SETTINGS_ACCELERATOR.to_owned()),
        register_accelerator: false,
        on_click: Some(deps.open_settings.clone()),
        ..MenuItem::blank()
    };
    let close = MenuItem {
        accelerator: Some(MAC_CLOSE_WINDOW_ACCELERATOR.to_owned()),
        ..MenuItem::role(MenuRole::Close)
    };
    let mut file = with_trailing_separator(items(spec.map(|spec| spec.file.items.as_slice())));
    file.push(close);
    let mut view = with_trailing_separator(items(spec.map(|spec| spec.view.items.as_slice())));
    view.extend([
        MenuItem::role(MenuRole::ToggleFullscreen),
        MenuItem::separator(),
        MenuItem::role(MenuRole::ToggleDevTools),
    ]);
    let mut menus = vec![
        MenuItem::menu(
            name.clone(),
            vec![
                MenuItem::labelled_role(MenuRole::About, text.about.replace("{product}", &name)),
                MenuItem::separator(),
                settings,
                MenuItem::separator(),
                MenuItem::role(MenuRole::Services),
                MenuItem::separator(),
                MenuItem::labelled_role(MenuRole::Hide, text.hide.replace("{product}", &name)),
                MenuItem::role(MenuRole::HideOthers),
                MenuItem::role(MenuRole::Unhide),
                MenuItem::separator(),
                MenuItem::labelled_role(MenuRole::Quit, text.quit.replace("{product}", &name)),
            ],
        ),
        MenuItem::menu(
            spec.map_or(text.file.clone(), |spec| spec.file.label.clone()),
            file,
        ),
        MenuItem::role(MenuRole::EditMenu),
        MenuItem::menu(
            spec.map_or(text.view.clone(), |spec| spec.view.label.clone()),
            view,
        ),
    ];
    if let Some(spec) = spec.filter(|spec| !spec.go.items.is_empty()) {
        menus.push(MenuItem::menu(
            spec.go.label.clone(),
            items(Some(spec.go.items.as_slice())),
        ));
    }
    menus.push(MenuItem::role(MenuRole::WindowMenu));
    if let Some(spec) = spec.filter(|spec| !spec.help.items.is_empty()) {
        menus.push(MenuItem {
            submenu: items(Some(spec.help.items.as_slice())),
            ..MenuItem::labelled_role(MenuRole::Help, spec.help.label.clone())
        });
    }
    menus
}

pub fn linux_app_menu_template(deps: &AppMenuDeps) -> Vec<MenuItem> {
    let text = (deps.text)();
    let reload = deps.reload_window.clone();
    let reload_item = MenuItem {
        id: Some(format!("command:{RELOAD_WINDOW_COMMAND}")),
        label: Some(text.reload_window),
        on_click: Some(Arc::new(move || {
            if let Some(reload) = &reload {
                reload();
            }
        })),
        ..MenuItem::blank()
    };
    vec![MenuItem::menu(
        text.view,
        vec![
            reload_item,
            MenuItem::separator(),
            MenuItem::role(MenuRole::ToggleFullscreen),
            MenuItem::role(MenuRole::ToggleDevTools),
        ],
    )]
}

pub struct AppMenu {
    darwin: bool,
    deps: AppMenuDeps,
    host: Arc<dyn MenuHost>,
    last: Mutex<Option<AppMenuSpec>>,
}

impl AppMenu {
    pub fn set_spec(&self, raw: &Value) -> bool {
        if !self.darwin {
            return false;
        }
        let Some(spec) = parse_app_menu_spec(raw) else {
            return false;
        };
        let mut last = self.last.lock();
        if last.as_ref() == Some(&spec) {
            return true;
        }
        self.host
            .set_application_menu(mac_app_menu_template(&self.deps, Some(&spec)));
        *last = Some(spec);
        true
    }
}

pub fn install_app_menu(platform: Platform, deps: AppMenuDeps, host: Arc<dyn MenuHost>) -> AppMenu {
    let darwin = platform == Platform::Darwin;
    if darwin {
        host.set_about_panel_name(&deps.product_name);
        host.set_application_menu(mac_app_menu_template(&deps, None));
    } else {
        host.set_application_menu(linux_app_menu_template(&deps));
    }
    AppMenu {
        darwin,
        deps,
        host,
        last: Mutex::new(None),
    }
}
