use std::rc::Rc;

use gpui_kit::component::radio::{Radio as KitRadio, RadioGroup};
use gpui_kit::{App, ElementId, IntoElement, RenderOnce, SharedString, Window};

pub struct RadioOption<T> {
    pub value: T,
    pub label: SharedString,
    pub disabled: bool,
}

impl<T> RadioOption<T> {
    pub fn new(value: T, label: impl Into<SharedString>) -> Self {
        Self {
            value,
            label: label.into(),
            disabled: false,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

type ChangeHandler<T> = Rc<dyn Fn(&T, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Radio<T: Clone + PartialEq + 'static> {
    id: ElementId,
    value: Option<T>,
    options: Vec<RadioOption<T>>,
    disabled: bool,
    on_change: ChangeHandler<T>,
}

impl<T: Clone + PartialEq + 'static> Radio<T> {
    pub fn new(
        id: impl Into<ElementId>,
        value: Option<T>,
        options: Vec<RadioOption<T>>,
        on_change: impl Fn(&T, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            value,
            options,
            disabled: false,
            on_change: Rc::new(on_change),
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

impl<T: Clone + PartialEq + 'static> RenderOnce for Radio<T> {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let selected = self.value.as_ref().and_then(|value| {
            self.options
                .iter()
                .position(|option| &option.value == value)
        });
        let picks: Vec<T> = self
            .options
            .iter()
            .map(|option| option.value.clone())
            .collect();
        let on_change = self.on_change;
        let items = self.options.into_iter().map(|option| {
            KitRadio::new(option.label.clone())
                .accessibility_label(option.label)
                .disabled(option.disabled)
        });
        RadioGroup::vertical(self.id)
            .disabled(self.disabled)
            .selected_index(selected)
            .children(items)
            .on_change(move |index, window, cx| {
                if let Some(value) = picks.get(*index) {
                    on_change(value, window, cx);
                }
            })
    }
}
