use gpui_kit::prelude::*;
use gpui_kit::{Context, ElementId, Entity, EventEmitter, MouseButton, Render, Window, div, px};
use ostia_ui::components::{EmptyState, IconButton, IconName, StatusLine, StatusTone, hint};
use ostia_ui::icons::{IconSize, icon};
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::{TAB_MAX_W, TAB_MIN_W, TABSTRIP_H, TextStep, UNFOCUSED_PANE_DIM, UiText};

use super::terminal::view::{TerminalEvent, TerminalView};

const TAB_LINE: f32 = 2.;
const TAB_MAIN_LEFT: f32 = 10.;
const TAB_END: f32 = 4.;
const TAB_GAP: f32 = 6.;

pub enum PaneEvent {
    Activated,
    Closed,
}

impl EventEmitter<PaneEvent> for PaneView {}

pub struct PaneView {
    index: usize,
    terminal: Result<Entity<TerminalView>, String>,
    active: bool,
    dimmed: bool,
    status: Option<(StatusTone, &'static str)>,
}

const FIXTURE_STATUS: &str = "Fixture: pane status comes from the panes core, which is not ported.";
const SHELL_EXITED: &str = "The shell exited.";

impl PaneView {
    pub fn new(
        index: usize,
        shell_argv: &[String],
        show_fixture_status: bool,
        cx: &mut Context<Self>,
    ) -> Self {
        let terminal = TerminalView::spawn(shell_argv, cx).map_err(|error| error.to_string());
        if let Ok(view) = &terminal {
            cx.subscribe(view, |pane, _, event, cx| match event {
                TerminalEvent::Exited => {
                    pane.status = Some((StatusTone::Muted, SHELL_EXITED));
                    cx.notify();
                }
                TerminalEvent::TitleChanged => cx.notify(),
            })
            .detach();
        }
        Self {
            index,
            terminal,
            active: false,
            dimmed: false,
            status: show_fixture_status.then_some((StatusTone::Muted, FIXTURE_STATUS)),
        }
    }

    pub(super) fn set_active(
        &mut self,
        active: bool,
        split: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.active = active;
        self.dimmed = split && !active;
        if active && let Ok(view) = &self.terminal {
            let handle = view.read(cx).focus_handle();
            window.focus(&handle, cx);
        }
        cx.notify();
    }

    fn title(&self, cx: &Context<Self>) -> String {
        match &self.terminal {
            Ok(view) => {
                let title = view.read(cx).title();
                if title.is_empty() {
                    "Terminal".to_owned()
                } else {
                    title
                }
            }
            Err(_) => "Terminal".to_owned(),
        }
    }

    fn render_tab(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let t = *cx.tokens();
        let line = if self.active { t.brand } else { t.line_strong };
        let title = self.title(cx);
        let close = cx.listener(|_, _, _, cx| cx.emit(PaneEvent::Closed));
        div()
            .id(ElementId::NamedInteger(
                "pane-tab".into(),
                self.index as u64,
            ))
            .relative()
            .flex()
            .flex_1()
            .h(TABSTRIP_H + px(1.))
            .min_w(TAB_MIN_W)
            .max_w(TAB_MAX_W)
            .items_center()
            .gap(px(TAB_GAP))
            .pl(px(TAB_MAIN_LEFT))
            .pr(px(TAB_END))
            .bg(t.surface_1)
            .border_r_1()
            .border_color(t.line)
            .text_color(t.fg)
            .ui_text(TextStep::Sm, cx)
            .tooltip(hint(title.clone()))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(TAB_LINE))
                    .bg(line),
            )
            .child(icon(
                IconName::TerminalWindow,
                IconSize::Standard,
                t.fg_muted,
            ))
            .child(div().flex_1().min_w_0().truncate().child(title))
            .child(
                IconButton::new(
                    ElementId::NamedInteger("pane-close".into(), self.index as u64),
                    IconName::X,
                    "Close pane",
                )
                .on_click(close),
            )
    }
}

impl Render for PaneView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = *cx.tokens();
        let tab = self.render_tab(cx);
        let dismiss = cx.listener(|pane, _, _, cx| {
            pane.status = None;
            cx.notify();
        });
        let body = match &self.terminal {
            Ok(view) => view.clone().into_any_element(),
            Err(error) => EmptyState::surface()
                .title("The terminal did not start")
                .desc(error.clone())
                .into_any_element(),
        };
        div()
            .id(ElementId::NamedInteger("pane".into(), self.index as u64))
            .flex()
            .flex_col()
            .size_full()
            .bg(t.surface_1)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(PaneEvent::Activated)),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .h(TABSTRIP_H)
                    .bg(t.surface_2)
                    .border_b_1()
                    .border_color(t.line)
                    .child(tab),
            )
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(body)
                    .when(self.dimmed, |body| {
                        body.child(
                            div()
                                .absolute()
                                .inset_0()
                                .bg(t.bg)
                                .opacity(UNFOCUSED_PANE_DIM),
                        )
                    }),
            )
            .when_some(self.status, |pane, (tone, text)| {
                pane.child(StatusLine::new(tone, text).on_dismiss(
                    ElementId::NamedInteger("pane-status-dismiss".into(), self.index as u64),
                    "Dismiss",
                    dismiss,
                ))
            })
    }
}
