use gpui_kit::component::input::{Escape, InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, Context, Entity, IntoElement, Render, SharedString, Subscription, Window, div,
};

use super::input::Input;

type DoneHandler = Box<dyn Fn(Option<String>, &mut Window, &mut App)>;

pub struct RenameInput {
    state: Entity<InputState>,
    label: SharedString,
    on_done: DoneHandler,
    done: bool,
    _subscription: Subscription,
}

impl RenameInput {
    pub fn new(
        value: impl Into<SharedString>,
        label: impl Into<SharedString>,
        on_done: impl Fn(Option<String>, &mut Window, &mut App) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = cx.new(|cx| InputState::new(window, cx).default_value(value));
        state.update(cx, |state, cx| {
            state.focus(window, cx);
            state.select_all(window, cx);
        });
        let _subscription = cx.subscribe_in(&state, window, |this, _, event, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                let draft = this.state.read(cx).value().to_string();
                this.finish(Some(draft), window, cx);
            }
        });
        Self {
            state,
            label: label.into(),
            on_done: Box::new(on_done),
            done: false,
            _subscription,
        }
    }

    fn finish(&mut self, name: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.done {
            self.done = true;
            (self.on_done)(name, window, cx);
        }
    }
}

impl Render for RenameInput {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .on_action(cx.listener(|this, _: &Escape, window, cx| this.finish(None, window, cx)))
            .child(Input::new(&self.state, self.label.clone()).inline())
    }
}
