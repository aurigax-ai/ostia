use gpui_kit::prelude::*;
use gpui_kit::{Context, Entity, FocusHandle, Render, Window, div};
use ostia_ui::components::{EmptyState, IconName};
use ostia_ui::icons::{IconSize, icon, sync_icon_weight};
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::{FONT_UI, TextStep, UiText};

use super::fixtures::fixture_workspaces;
use super::settings_screen::SettingsScreen;
use super::work_area::WorkArea;
use super::{Screen, ShellOptions, palette, rail, top_bar};

gpui_kit::actions!(
    ostia_shell,
    [ToggleCommandPalette, OpenSettings, ToggleRail]
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveView {
    LiveWorkspace,
    Fixture(usize),
    Settings,
}

pub struct ShellRoot {
    pub(super) view: ActiveView,
    pub(super) rail_collapsed: bool,
    pub(super) work: Entity<WorkArea>,
    pub(super) settings: Entity<SettingsScreen>,
    focus: FocusHandle,
}

impl ShellRoot {
    pub fn new(options: ShellOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let work = cx.new(|cx| WorkArea::new(&options.shell_argv, window, cx));
        let settings = cx.new(|cx| SettingsScreen::new(window, cx));
        let focus = cx.focus_handle();
        let view = match options.screen {
            Screen::Settings => ActiveView::Settings,
            Screen::Main | Screen::Palette => ActiveView::LiveWorkspace,
        };
        if options.screen == Screen::Palette {
            let root = cx.entity().downgrade();
            window.defer(cx, move |window, cx| palette::open(root, window, cx));
        }
        Self {
            view,
            rail_collapsed: false,
            work,
            settings,
            focus,
        }
    }

    pub fn active_view(&self) -> ActiveView {
        self.view
    }

    pub fn rail_collapsed(&self) -> bool {
        self.rail_collapsed
    }

    pub(super) fn select_view(&mut self, view: ActiveView, cx: &mut Context<Self>) {
        self.view = view;
        cx.notify();
    }

    pub(super) fn toggle_rail(&mut self, cx: &mut Context<Self>) {
        self.rail_collapsed = !self.rail_collapsed;
        cx.notify();
    }

    fn render_work(&mut self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let muted = cx.tokens().fg;
        match self.view {
            ActiveView::LiveWorkspace => self.work.clone().into_any_element(),
            ActiveView::Settings => self.settings.clone().into_any_element(),
            ActiveView::Fixture(index) => {
                let title = fixture_workspaces()
                    .get(index)
                    .map_or("Fixture", |fixture| fixture.title);
                EmptyState::surface()
                    .icon(icon(IconName::TerminalWindow, IconSize::Standard, muted))
                    .title(title)
                    .desc("This workspace is a fixture. The workspaces core is not ported.")
                    .into_any_element()
            }
        }
    }
}

impl Render for ShellRoot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        sync_icon_weight(window.scale_factor());
        let t = *cx.tokens();
        let work = self.render_work(cx);
        div()
            .id("shell-root")
            .track_focus(&self.focus)
            .key_context("OstiaShell")
            .on_action(cx.listener(|this, _: &ToggleRail, _, cx| this.toggle_rail(cx)))
            .on_action(cx.listener(|this, _: &OpenSettings, _, cx| {
                this.select_view(ActiveView::Settings, cx);
            }))
            .on_action(cx.listener(|_, _: &ToggleCommandPalette, window, cx| {
                palette::open(cx.entity().downgrade(), window, cx);
            }))
            .flex()
            .flex_col()
            .size_full()
            .bg(t.bg)
            .text_color(t.fg)
            .font_family(FONT_UI)
            .ui_text(TextStep::Base, cx)
            .child(top_bar::render(self.rail_collapsed, cx))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(rail::render(self, cx))
                    .child(div().flex_1().min_w_0().h_full().child(work)),
            )
    }
}
