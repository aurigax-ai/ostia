use gpui_kit::component::WindowExt as _;
use gpui_kit::component::dialog::Dialog;
use gpui_kit::{App, Window};

pub fn open_dialog(
    window: &mut Window,
    cx: &mut App,
    build: impl Fn(Dialog, &mut Window, &mut App) -> Dialog + 'static,
) {
    window.open_dialog(cx, build);
}

pub fn close_dialog(window: &mut Window, cx: &mut App) {
    window.close_dialog(cx);
}
