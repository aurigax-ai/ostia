use gpui_kit::prelude::*;
use gpui_kit::{Context, IntoElement, MouseButton, WindowControlArea, div, px};
use ostia_ui::components::{IconButton, IconButtonSize, IconName, Kbd, RowButton};
use ostia_ui::icons::{IconSize, icon};
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::{RAIL_W, SPACE_2, TOPBAR_H, TextStep, UiText};

use super::root::{ActiveView, ShellRoot};
use super::{palette, window_controls};

const CENTER_MAX_W: f32 = 440.;
const CENTER_MIN_W: f32 = 160.;
const CENTER_H: f32 = 24.;
const MAC_TRAFFIC_LIGHTS: f32 = 80.;

pub(super) fn render(cx: &mut Context<ShellRoot>) -> impl IntoElement + use<> {
    let t = *cx.tokens();
    let root = cx.entity().downgrade();
    let toggle = cx.listener(|this, _, _, cx| this.toggle_rail(cx));
    let new_workspace = cx.listener(|this, _, _, cx| {
        this.stores.new_workspace(cx);
        this.show_workspace(cx);
    });
    let settings = cx.listener(|this, _, _, cx| this.select_view(ActiveView::Settings, cx));
    let stop = |_: &gpui_kit::MouseDownEvent, _: &mut gpui_kit::Window, cx: &mut gpui_kit::App| {
        cx.stop_propagation();
    };
    div()
        .id("top-bar")
        .flex()
        .flex_none()
        .items_center()
        .justify_between()
        .h(TOPBAR_H)
        .pl(if cfg!(target_os = "macos") {
            px(MAC_TRAFFIC_LIGHTS)
        } else {
            SPACE_2
        })
        .bg(t.surface_1)
        .border_b_1()
        .border_color(t.line)
        .window_control_area(WindowControlArea::Drag)
        .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move())
        .child(
            div()
                .flex()
                .flex_1()
                .items_center()
                .min_w(RAIL_W - SPACE_2)
                .child(
                    div().on_mouse_down(MouseButton::Left, stop).child(
                        IconButton::new("new-workspace", IconName::Plus, "New workspace")
                            .size(IconButtonSize::Bar)
                            .on_click(new_workspace),
                    ),
                )
                .child(
                    div().on_mouse_down(MouseButton::Left, stop).child(
                        IconButton::new("toggle-rail", IconName::SidebarSimple, "Toggle sidebar")
                            .size(IconButtonSize::Bar)
                            .on_click(toggle),
                    ),
                ),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(CENTER_MIN_W))
                .max_w(px(CENTER_MAX_W))
                .h(px(CENTER_H))
                .rounded(px(6.))
                .bg(t.surface_2)
                .on_mouse_down(MouseButton::Left, stop)
                .child(
                    RowButton::new("command-center", "Search or run a command")
                        .on_click(move |_, window, cx| palette::open(root.clone(), window, cx))
                        .child(
                            div()
                                .flex()
                                .flex_1()
                                .min_w_0()
                                .h(px(CENTER_H))
                                .items_center()
                                .gap(px(4.))
                                .px(SPACE_2)
                                .text_color(t.fg_muted)
                                .ui_text(TextStep::Base, cx)
                                .child(icon(
                                    IconName::MagnifyingGlass,
                                    IconSize::Standard,
                                    t.fg_muted,
                                ))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .child("Search or run a command"),
                                )
                                .child(Kbd::new("Ctrl+Shift+P").bare()),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .flex_1()
                .items_center()
                .justify_end()
                .gap(px(2.))
                .child(
                    div().on_mouse_down(MouseButton::Left, stop).child(
                        IconButton::new("open-settings", IconName::GearSix, "Settings")
                            .size(IconButtonSize::Bar)
                            .on_click(settings),
                    ),
                )
                .child(window_controls::render(cx)),
        )
}
