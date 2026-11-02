use gpui_kit::prelude::*;
use gpui_kit::{
    App, ClickEvent, Context, IntoElement, MouseButton, Role, TestSupportExt as _, Window, div, px,
};
use ostia_ui::components::IconName;
use ostia_ui::icons::{IconSize, icon};
use ostia_ui::theme::UiTheme;

use super::root::ShellRoot;

const BUTTON: f32 = 24.;
const GAP: f32 = 12.;
const HOVER: f32 = 0.18;
const ACTIVE: f32 = 0.26;

fn control<F: Fn(&mut Window, &mut App) + 'static>(
    id: &'static str,
    label: &'static str,
    name: IconName,
    action: F,
    cx: &App,
) -> impl IntoElement + use<F> {
    let t = *cx.tokens();
    div()
        .id(id)
        .role(Role::Button)
        .aria_label(label)
        .test_support()
        .flex()
        .size(px(BUTTON))
        .items_center()
        .justify_center()
        .rounded_full()
        .hover(move |style| style.bg(t.fg.opacity(HOVER)))
        .active(move |style| style.bg(t.fg.opacity(ACTIVE)))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_: &ClickEvent, window, cx| {
            cx.stop_propagation();
            action(window, cx);
        })
        .child(icon(name, IconSize::Standard, t.fg))
}

pub(super) fn render(cx: &mut Context<ShellRoot>) -> impl IntoElement + use<> {
    div()
        .flex()
        .items_center()
        .gap(px(GAP))
        .pl(px(6.))
        .pr(px(10.))
        .when(!cfg!(target_os = "macos"), |row| {
            row.child(control(
                "window-minimize",
                "Minimize",
                IconName::Minus,
                |window, _| window.minimize_window(),
                cx,
            ))
            .child(control(
                "window-maximize",
                "Maximize",
                IconName::Square,
                |window, _| window.zoom_window(),
                cx,
            ))
            .child(control(
                "window-close",
                "Close",
                IconName::X,
                |window, _| window.remove_window(),
                cx,
            ))
        })
}
