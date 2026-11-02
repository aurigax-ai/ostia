use gpui_kit::prelude::*;
use gpui_kit::{Context, Entity, FocusHandle, Render, Window, div};
use ostia_model::layout::types::Direction;
use ostia_ui::icons::sync_icon_weight;
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::{FONT_UI, TextStep, UiText};

use super::settings_screen::SettingsScreen;
use super::window_stores::WindowStores;
use super::work_area::WorkArea;
use super::{Screen, ShellOptions, palette, rail, top_bar};

gpui_kit::actions!(
    ostia_shell,
    [
        ToggleCommandPalette,
        OpenSettings,
        ToggleRail,
        NewWorkspace,
        NewTerminal,
        SplitRight,
    ]
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveView {
    Workspace,
    Settings,
}

pub struct ShellRoot {
    pub(super) view: ActiveView,
    pub(super) stores: WindowStores,
    pub(super) rail_collapsed: bool,
    pub(super) work: Entity<WorkArea>,
    pub(super) settings: Entity<SettingsScreen>,
    focus: FocusHandle,
}

impl ShellRoot {
    pub fn new(options: ShellOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let stores = WindowStores::new(&options.namespace, cx);
        stores.new_workspace(cx);
        let work = cx.new(|cx| {
            WorkArea::new(
                stores.clone(),
                options.bridge.clone(),
                options.terminals.clone(),
                window,
                cx,
            )
        });
        let settings = cx.new(|cx| SettingsScreen::new(window, cx));
        let focus = cx.focus_handle();
        let view = match options.screen {
            Screen::Settings => ActiveView::Settings,
            Screen::Main | Screen::Palette => ActiveView::Workspace,
        };
        if options.screen == Screen::Palette {
            let root = cx.entity().downgrade();
            window.defer(cx, move |window, cx| palette::open(root, window, cx));
        }
        Self {
            view,
            stores,
            rail_collapsed: false,
            work,
            settings,
            focus,
        }
    }

    pub fn active_view(&self) -> ActiveView {
        self.view
    }

    pub fn stores(&self) -> &WindowStores {
        &self.stores
    }

    pub fn work_area(&self) -> &Entity<WorkArea> {
        &self.work
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

    pub(super) fn show_workspace(&mut self, cx: &mut Context<Self>) {
        self.select_view(ActiveView::Workspace, cx);
    }

    fn render_work(&self) -> gpui_kit::AnyElement {
        match self.view {
            ActiveView::Workspace => self.work.clone().into_any_element(),
            ActiveView::Settings => self.settings.clone().into_any_element(),
        }
    }
}

impl Render for ShellRoot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        sync_icon_weight(window.scale_factor());
        let t = *cx.tokens();
        let work = self.render_work();
        div()
            .id("shell-root")
            .track_focus(&self.focus)
            .key_context("OstiaShell")
            .on_action(cx.listener(|this, _: &ToggleRail, _, cx| this.toggle_rail(cx)))
            .on_action(cx.listener(|this, _: &OpenSettings, _, cx| {
                this.select_view(ActiveView::Settings, cx);
            }))
            .on_action(cx.listener(|this, _: &NewWorkspace, _, cx| {
                this.stores.new_workspace(cx);
                this.show_workspace(cx);
            }))
            .on_action(cx.listener(|this, _: &NewTerminal, _, cx| {
                this.stores.new_terminal(cx);
                this.show_workspace(cx);
            }))
            .on_action(cx.listener(|this, _: &SplitRight, _, cx| {
                this.stores.split_active(Direction::Horizontal, cx);
                this.show_workspace(cx);
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
            .child(top_bar::render(cx))
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
