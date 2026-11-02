use std::rc::Rc;

use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, Context, Entity, IntoElement, KeyDownEvent, RenderOnce, SharedString, Subscription,
    Window, div,
};

use super::input::Input;

type CommitHandler = Rc<dyn Fn(&str, &mut Window, &mut App) -> bool>;
type CancelHandler = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(Clone, Copy)]
enum Mode {
    Text,
    Number { min: Option<f64>, max: Option<f64> },
}

impl Mode {
    fn normalize(self, text: &str) -> Option<String> {
        match self {
            Self::Text => Some(text.to_owned()),
            Self::Number { min, max } => {
                let number: f64 = text.trim().parse().ok().filter(|n: &f64| n.is_finite())?;
                let floored = min.map_or(number, |min| number.max(min));
                Some(max.map_or(floored, |max| floored.min(max)).to_string())
            }
        }
    }
}

pub struct CommitInputState {
    input: Entity<InputState>,
    saved: SharedString,
    dirty: bool,
    mode: Mode,
    on_commit: CommitHandler,
    on_cancel: Option<CancelHandler>,
    _subscription: Subscription,
}

impl CommitInputState {
    fn create<V: 'static>(
        saved: SharedString,
        mode: Mode,
        on_commit: CommitHandler,
        window: &mut Window,
        cx: &mut Context<V>,
    ) -> Entity<Self> {
        cx.new(|cx| {
            let initial = saved.clone();
            let input = cx.new(|cx| InputState::new(window, cx).default_value(initial));
            let _subscription = cx.subscribe_in(
                &input,
                window,
                |state: &mut Self, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => state.dirty = true,
                    InputEvent::PressEnter { .. } | InputEvent::Blur => state.commit(window, cx),
                    InputEvent::Focus => {}
                },
            );
            Self {
                input,
                saved,
                dirty: false,
                mode,
                on_commit,
                on_cancel: None,
                _subscription,
            }
        })
    }

    pub fn new<V: 'static>(
        value: impl Into<SharedString>,
        on_commit: impl Fn(&str, &mut Window, &mut App) -> bool + 'static,
        window: &mut Window,
        cx: &mut Context<V>,
    ) -> Entity<Self> {
        Self::create(value.into(), Mode::Text, Rc::new(on_commit), window, cx)
    }

    pub fn number<V: 'static>(
        value: f64,
        min: Option<f64>,
        max: Option<f64>,
        on_commit: impl Fn(f64, &mut Window, &mut App) + 'static,
        window: &mut Window,
        cx: &mut Context<V>,
    ) -> Entity<Self> {
        let commit = move |text: &str, window: &mut Window, cx: &mut App| {
            if let Ok(number) = text.parse() {
                on_commit(number, window, cx);
            }
            true
        };
        Self::create(
            value.to_string().into(),
            Mode::Number { min, max },
            Rc::new(commit),
            window,
            cx,
        )
    }

    pub fn on_cancel(&mut self, on_cancel: impl Fn(&mut Window, &mut App) + 'static) -> &mut Self {
        self.on_cancel = Some(Rc::new(on_cancel));
        self
    }

    pub fn input(&self) -> &Entity<InputState> {
        &self.input
    }

    fn show_saved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dirty = false;
        let saved = self.saved.clone();
        self.input
            .update(cx, |input, cx| input.set_value(saved, window, cx));
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_saved(window, cx);
        if let Some(on_cancel) = self.on_cancel.clone() {
            on_cancel(window, cx);
        }
    }

    fn sync(&mut self, value: &SharedString, window: &mut Window, cx: &mut Context<Self>) {
        if self.saved != *value {
            self.saved = value.clone();
            self.show_saved(window, cx);
        }
    }

    fn commit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.dirty {
            return;
        }
        let text = self.input.read(cx).value();
        match self.mode.normalize(&text) {
            None => self.show_saved(window, cx),
            Some(text) if text == self.saved.as_ref() => self.cancel(window, cx),
            Some(text) => {
                let on_commit = self.on_commit.clone();
                if on_commit(&text, window, cx) {
                    self.show_saved(window, cx);
                }
            }
        }
    }

    fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.dirty {
            return false;
        }
        self.cancel(window, cx);
        true
    }
}

#[derive(IntoElement)]
pub struct CommitInput {
    state: Entity<CommitInputState>,
    label: SharedString,
    value: SharedString,
    width: Option<f32>,
    code: bool,
    disabled: bool,
    invalid: bool,
}

impl CommitInput {
    pub fn new(
        state: &Entity<CommitInputState>,
        label: impl Into<SharedString>,
        value: impl Into<SharedString>,
    ) -> Self {
        Self {
            state: state.clone(),
            label: label.into(),
            value: value.into(),
            width: None,
            code: false,
            disabled: false,
            invalid: false,
        }
    }

    pub fn number(
        state: &Entity<CommitInputState>,
        label: impl Into<SharedString>,
        value: f64,
    ) -> Self {
        Self::new(state, label, value.to_string())
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(width);
        self
    }

    pub fn code(mut self) -> Self {
        self.code = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }
}

impl RenderOnce for CommitInput {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let value = self.value;
        let input = self.state.update(cx, |state, cx| {
            state.sync(&value, window, cx);
            state.input.clone()
        });
        let state = self.state;
        let field = Input::new(&input, self.label)
            .disabled(self.disabled)
            .invalid(self.invalid)
            .when_some(self.width, |field, width| field.width(width));
        let field = if self.code { field.code() } else { field };
        div()
            .capture_key_down(move |event: &KeyDownEvent, window, cx| {
                let escaped = event.keystroke.key == "escape"
                    && state.update(cx, |state, cx| state.escape(window, cx));
                if escaped {
                    cx.stop_propagation();
                }
            })
            .child(field)
    }
}
