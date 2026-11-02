pub use gpui_kit::component::tooltip::Tooltip;

use gpui_kit::{AnyView, App, SharedString, Window};

pub fn hint(label: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let label = label.into();
    move |window, cx| Tooltip::new(label.clone()).build(window, cx)
}
