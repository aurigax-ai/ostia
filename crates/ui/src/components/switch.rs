use std::rc::Rc;

use gpui_kit::component::switch::Switch as KitSwitch;
use gpui_kit::{App, ElementId, IntoElement, RenderOnce, SharedString, Window};

type ChangeHandler = Rc<dyn Fn(&bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    label: SharedString,
    checked: bool,
    disabled: bool,
    on_change: Option<ChangeHandler>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, checked: bool) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            checked,
            disabled: false,
            on_change: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_change(mut self, handler: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Switch {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        use gpui_kit::component::Disableable as _;
        let mut switch = KitSwitch::new(self.id)
            .accessibility_label(self.label)
            .checked(self.checked)
            .disabled(self.disabled);
        if let Some(handler) = self.on_change {
            switch = switch.on_change(move |checked, window, cx| handler(checked, window, cx));
        }
        switch
    }
}
