use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, ElementId, Role, TestSupportExt as _, div, px};
use ostia_model::layout::tree::first_tab_pane_id;
use ostia_model::layout::types::{Direction, TabNode};
use ostia_ui::components::{IconButton, IconName, hint};
use ostia_ui::icons::{IconSize, icon};
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::{TAB_MAX_W, TAB_MIN_W, TABSTRIP_H, TextStep, UiText};

use super::window_stores::WindowStores;

const TAB_LINE: f32 = 2.;
const TAB_MAIN_LEFT: f32 = 10.;
const TAB_END: f32 = 4.;
const TAB_GAP: f32 = 6.;
const ACTIONS_GAP: f32 = 2.;
const ACTIONS_END: f32 = 4.;

const CLOSE_PANE: &str = "Close pane";
const NEW_TERMINAL: &str = "New terminal";
const SPLIT_RIGHT: &str = "Split right";
const SPLIT_DOWN: &str = "Split down";

pub(super) struct StripContext {
    pub stores: WindowStores,
    pub workspace_id: String,
    pub active_pane_id: String,
}

fn scoped_id(prefix: &str, id: &str) -> ElementId {
    ElementId::Name(format!("{prefix}-{id}").into())
}

fn tab_title(tab: &TabNode) -> String {
    match tab {
        TabNode::Pane(pane) => pane.title.clone(),
        TabNode::Split(split) => split.name.clone().unwrap_or_default(),
    }
}

fn render_tab(tab: &TabNode, shown: bool, context: &StripContext, cx: &App) -> AnyElement {
    let t = *cx.tokens();
    let pane_id = first_tab_pane_id(tab).to_owned();
    let is_active = shown && pane_id == context.active_pane_id;
    let line = if is_active { t.brand } else { t.line_strong };
    let title = tab_title(tab);
    let select_stores = context.stores.clone();
    let select_workspace = context.workspace_id.clone();
    let select_pane = pane_id.clone();
    let close_stores = context.stores.clone();
    let close_workspace = context.workspace_id.clone();
    let close_pane = pane_id.clone();
    div()
        .id(scoped_id("pane-tab", tab.id()))
        .role(Role::Tab)
        .aria_label(title.clone())
        .test_support()
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
        .bg(if shown { t.surface_1 } else { t.surface_2 })
        .border_r_1()
        .border_color(t.line)
        .text_color(if shown { t.fg } else { t.fg_muted })
        .ui_text(TextStep::Sm, cx)
        .tooltip(hint(title.clone()))
        .on_click(move |_, _, cx| select_stores.focus_pane(&select_workspace, &select_pane, cx))
        .when(shown, |tab| {
            tab.child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(TAB_LINE))
                    .bg(line),
            )
        })
        .child(icon(
            IconName::TerminalWindow,
            IconSize::Standard,
            t.fg_muted,
        ))
        .child(div().flex_1().min_w_0().truncate().child(title))
        .child(
            IconButton::new(scoped_id("pane-close", tab.id()), IconName::X, CLOSE_PANE).on_click(
                move |_, _, cx| {
                    cx.stop_propagation();
                    close_stores.close_pane(&close_workspace, &close_pane, cx);
                },
            ),
        )
        .into_any_element()
}

fn render_actions(pane_id: &str, context: &StripContext) -> impl IntoElement + use<> {
    let action = |prefix: &str, name: IconName, label: &'static str, run: ActionRun| {
        let stores = context.stores.clone();
        let workspace = context.workspace_id.clone();
        let pane = pane_id.to_owned();
        IconButton::new(scoped_id(prefix, pane_id), name, label).on_click(move |_, _, cx| {
            stores.focus_pane(&workspace, &pane, cx);
            run(&stores, cx);
        })
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(ACTIONS_GAP))
        .pr(px(ACTIONS_END))
        .child(action(
            "pane-new-terminal",
            IconName::TerminalWindow,
            NEW_TERMINAL,
            WindowStores::new_terminal,
        ))
        .child(action(
            "pane-split-right",
            IconName::SquareSplitHorizontal,
            SPLIT_RIGHT,
            |stores, cx| stores.split_active(Direction::Horizontal, cx),
        ))
        .child(action(
            "pane-split-down",
            IconName::SquareSplitVertical,
            SPLIT_DOWN,
            |stores, cx| stores.split_active(Direction::Vertical, cx),
        ))
}

type ActionRun = fn(&WindowStores, &mut App);

pub(super) fn render_strip(
    tabs: &[TabNode],
    shown_id: &str,
    shown_pane_id: &str,
    context: &StripContext,
    cx: &App,
) -> impl IntoElement + use<> {
    let t = *cx.tokens();
    let rendered: Vec<AnyElement> = tabs
        .iter()
        .map(|tab| render_tab(tab, tab.id() == shown_id, context, cx))
        .collect();
    div()
        .flex()
        .flex_none()
        .h(TABSTRIP_H)
        .bg(t.surface_2)
        .border_b_1()
        .border_color(t.line)
        .child(div().flex().flex_1().min_w_0().children(rendered))
        .child(render_actions(shown_pane_id, context))
}
