mod fixtures;
mod palette;
mod pane;
mod rail;
mod root;
mod settings_screen;
pub mod terminal;
mod top_bar;
mod window_controls;
mod work_area;

use gpui_kit::component::window_border;
use gpui_kit::prelude::*;
use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, KeyBinding, Render, Window, WindowBounds,
    WindowDecorations, WindowOptions, point, px, size,
};

pub use fixtures::{FixtureWorkspace, fixture_workspaces};
pub use root::{OpenSettings, ShellRoot, ToggleCommandPalette, ToggleRail};

const WINDOW_WIDTH: f32 = 1280.;
const WINDOW_HEIGHT: f32 = 800.;
const WINDOW_INSET: f32 = 80.;
const WINDOW_TITLE: &str = "Ostia";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Screen {
    #[default]
    Main,
    Settings,
    Palette,
}

impl Screen {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("settings") => Self::Settings,
            Some("palette") => Self::Palette,
            _ => Self::Main,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ShellOptions {
    pub screen: Screen,
    pub theme: Option<String>,
    pub shell_argv: Vec<String>,
}

pub fn bind_shell_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-shift-p", ToggleCommandPalette, None),
        KeyBinding::new("ctrl-,", OpenSettings, None),
        KeyBinding::new("ctrl-shift-b", ToggleRail, None),
    ]);
}

struct ShellWindow {
    root: Entity<ShellRoot>,
}

impl Render for ShellWindow {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        window_border().child(self.root.clone())
    }
}

pub fn open_shell_window(
    options: ShellOptions,
    cx: &mut App,
) -> gpui_kit::Result<Entity<ShellRoot>> {
    if let Some(theme) = &options.theme {
        ostia_ui::theme::set_theme(theme, cx);
    }
    let window_options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            point(px(WINDOW_INSET), px(WINDOW_INSET)),
            size(px(WINDOW_WIDTH), px(WINDOW_HEIGHT)),
        ))),
        titlebar: Some(gpui_kit::TitlebarOptions {
            title: Some(WINDOW_TITLE.into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(9.), px(9.))),
        }),
        window_decorations: Some(WindowDecorations::Client),
        app_owns_titlebar_drag: true,
        ..WindowOptions::default()
    };
    let mut built = None;
    gpui_kit::open_window(window_options, cx, |window, cx| {
        let root = cx.new(|cx| ShellRoot::new(options, window, cx));
        built = Some(root.clone());
        cx.new(|_| ShellWindow { root })
    })?;
    built.ok_or_else(|| gpui_kit::anyhow!("window did not build"))
}

pub fn run_window(options: ShellOptions) {
    ostia_ui::application().run(move |cx: &mut App| {
        ostia_ui::init(cx);
        bind_shell_keys(cx);
        if let Err(error) = open_shell_window(options, cx) {
            tracing::error!(%error, "window failed to open");
            cx.quit();
        }
    });
}
