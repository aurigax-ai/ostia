use gpui_kit::prelude::*;
use gpui_kit::{Context, ElementId, Entity, EventEmitter, MouseButton, Render, Window, div};
use ostia_ui::components::EmptyState;
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::UNFOCUSED_PANE_DIM;

use super::Terminals;
use super::terminal::view::{TerminalEvent, TerminalView};

pub enum PaneEvent {
    Activated,
    ShellExited,
    TitleChanged(String),
}

impl EventEmitter<PaneEvent> for PaneView {}

pub struct PaneView {
    element_id: ElementId,
    terminal: Result<Entity<TerminalView>, String>,
    dimmed: bool,
}

const TERMINALS_OFF: &str = "Terminals are off in this run.";

impl PaneView {
    pub fn new(
        pane_id: &str,
        cwd: Option<&str>,
        terminals: &Terminals,
        cx: &mut Context<Self>,
    ) -> Self {
        let terminal = match terminals {
            Terminals::DefaultShell => {
                TerminalView::spawn(&[], cwd, cx).map_err(|error| error.to_string())
            }
            Terminals::Off => Err(TERMINALS_OFF.to_owned()),
        };
        if let Ok(view) = &terminal {
            cx.subscribe(view, |_, view, event, cx| match event {
                TerminalEvent::Exited => cx.emit(PaneEvent::ShellExited),
                TerminalEvent::TitleChanged => {
                    let title = view.read(cx).title();
                    if !title.is_empty() {
                        cx.emit(PaneEvent::TitleChanged(title));
                    }
                }
            })
            .detach();
        }
        Self {
            element_id: ElementId::Name(format!("pane-{pane_id}").into()),
            terminal,
            dimmed: false,
        }
    }

    pub(super) fn set_shown_state(
        &mut self,
        dimmed: bool,
        take_focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if take_focus && let Ok(view) = &self.terminal {
            let handle = view.read(cx).focus_handle();
            window.focus(&handle, cx);
        }
        if self.dimmed != dimmed {
            self.dimmed = dimmed;
            cx.notify();
        }
    }
}

impl Render for PaneView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = *cx.tokens();
        let body = match &self.terminal {
            Ok(view) => view.clone().into_any_element(),
            Err(error) => EmptyState::surface()
                .title("The terminal did not start")
                .desc(error.clone())
                .into_any_element(),
        };
        div()
            .id(self.element_id.clone())
            .relative()
            .size_full()
            .bg(t.surface_1)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(PaneEvent::Activated)),
            )
            .child(body)
            .when(self.dimmed, |pane| {
                pane.child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(t.bg)
                        .opacity(UNFOCUSED_PANE_DIM),
                )
            })
    }
}
