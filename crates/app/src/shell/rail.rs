use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, App, Context, ElementId, IntoElement, SharedString, div, px};
use ostia_contract::attention::WorkspaceLiveState;
use ostia_model::workspaces::workspaces_store::workspace_title;
use ostia_ui::components::{IconButton, IconName, RowButton, StateBadge, WorkspaceState, hint};
use ostia_ui::icons::{IconSize, icon};
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::{RAIL_W, RAIL_W_COLLAPSED, SPACE_2, TextStep, UiText};

use super::root::{ActiveView, ShellRoot};

const LEAD_W: f32 = 16.;
const ROW_GAP: f32 = 2.;
const ROW_INSET: f32 = 6.;
const COLLAPSED_ROW: f32 = 32.;
const BADGE_OFFSET: f32 = -5.;
const BADGE_RING: f32 = 2.;
const CLOSE_INSET: f32 = 4.;
const CLOSE_WORKSPACE: &str = "Close workspace";

struct Row {
    id: ElementId,
    title: SharedString,
    location: Option<SharedString>,
    kind: IconName,
    state: WorkspaceState,
    target: RowTarget,
    active: bool,
}

#[derive(Clone)]
enum RowTarget {
    Settings,
    Workspace(String),
}

fn badge_state(state: WorkspaceLiveState) -> WorkspaceState {
    match state {
        WorkspaceLiveState::Idle => WorkspaceState::Idle,
        WorkspaceLiveState::Working => WorkspaceState::Working,
        WorkspaceLiveState::Waiting => WorkspaceState::Waiting,
        WorkspaceLiveState::Done => WorkspaceState::Done,
        WorkspaceLiveState::Error => WorkspaceState::Error,
    }
}

fn lead(row: &Row, active: bool, cx: &App) -> impl IntoElement + use<> {
    let t = *cx.tokens();
    let badge_id = ElementId::Name(format!("{}-badge", row.id).into());
    let kind_color = if active { t.fg_muted } else { t.fg_dim };
    div()
        .relative()
        .flex()
        .flex_none()
        .w(px(LEAD_W))
        .items_center()
        .justify_center()
        .child(icon(row.kind, IconSize::Standard, kind_color))
        .when(row.state != WorkspaceState::Idle, |lead| {
            lead.child(
                div()
                    .absolute()
                    .right(px(BADGE_OFFSET))
                    .bottom(px(BADGE_OFFSET))
                    .rounded_full()
                    .bg(if active { t.surface_2 } else { t.surface_1 })
                    .p(px(BADGE_RING / 2.))
                    .child(StateBadge::new(badge_id, row.state)),
            )
        })
}

fn render_close(row: &Row, cx: &mut Context<ShellRoot>) -> Option<AnyElement> {
    let RowTarget::Workspace(id) = &row.target else {
        return None;
    };
    let target = id.clone();
    let close = cx.listener(move |this, _, _, cx| {
        cx.stop_propagation();
        this.stores.close_workspace(&target, cx);
    });
    Some(
        div()
            .absolute()
            .top(px(CLOSE_INSET))
            .right(px(CLOSE_INSET))
            .child(
                IconButton::new(
                    ElementId::Name(format!("rail-close-{id}").into()),
                    IconName::X,
                    CLOSE_WORKSPACE,
                )
                .on_click(close),
            )
            .into_any_element(),
    )
}

fn render_row(row: Row, collapsed: bool, cx: &mut Context<ShellRoot>) -> AnyElement {
    let active = row.active;
    let target = row.target.clone();
    let select = cx.listener(move |this, _, _, cx| match &target {
        RowTarget::Settings => this.select_view(ActiveView::Settings, cx),
        RowTarget::Workspace(id) => {
            this.stores.select_workspace(id, cx);
            this.show_workspace(cx);
        }
    });
    let t = *cx.tokens();
    let lead = lead(&row, active, cx);
    let button = RowButton::new(row.id.clone(), row.title.clone())
        .active(active)
        .on_click(select);
    if collapsed {
        return div()
            .id(ElementId::Name(format!("{}-hint", row.id).into()))
            .size(px(COLLAPSED_ROW))
            .tooltip(hint(row.title))
            .child(
                button.child(
                    div()
                        .flex()
                        .size(px(COLLAPSED_ROW))
                        .items_center()
                        .justify_center()
                        .child(lead),
                ),
            )
            .into_any_element();
    }
    let close = active.then(|| render_close(&row, cx)).flatten();
    let row_body = button.child(
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_start()
            .gap(SPACE_2)
            .py(px(ROW_INSET))
            .pl(SPACE_2)
            .pr(px(ROW_GAP * 2.))
            .child(div().flex().h(px(20.)).items_center().child(lead))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(ROW_GAP))
                    .child(
                        div()
                            .truncate()
                            .ui_text(TextStep::Base, cx)
                            .child(row.title),
                    )
                    .when_some(row.location, |body, location| {
                        body.child(
                            div()
                                .truncate()
                                .font_code()
                                .text_color(t.fg_muted)
                                .ui_text(TextStep::Xs, cx)
                                .child(location),
                        )
                    }),
            ),
    );
    div()
        .relative()
        .child(row_body)
        .children(close)
        .into_any_element()
}

pub(super) fn render(root: &ShellRoot, cx: &mut Context<ShellRoot>) -> impl IntoElement + use<> {
    let t = *cx.tokens();
    let collapsed = root.rail_collapsed;
    let view = root.view;
    let mut rows = Vec::new();
    if view == ActiveView::Settings {
        rows.push(Row {
            id: "rail-settings".into(),
            title: "Settings".into(),
            location: None,
            kind: IconName::GearSix,
            state: WorkspaceState::Idle,
            target: RowTarget::Settings,
            active: true,
        });
    }
    let store = root.stores.workspaces.read(cx).state();
    let selected = store.active_workspace_id();
    rows.extend(store.workspaces().iter().map(|workspace| Row {
        id: ElementId::Name(format!("rail-workspace-{}", workspace.id).into()),
        title: workspace_title(workspace).to_owned().into(),
        location: Some(workspace.work_dir.clone().into()),
        kind: IconName::TerminalWindow,
        state: badge_state(workspace.state),
        target: RowTarget::Workspace(workspace.id.clone()),
        active: view == ActiveView::Workspace && selected == Some(workspace.id.as_str()),
    }));
    let rendered: Vec<AnyElement> = rows
        .into_iter()
        .map(|row| render_row(row, collapsed, cx))
        .collect();
    div()
        .flex()
        .flex_col()
        .flex_none()
        .h_full()
        .w(if collapsed { RAIL_W_COLLAPSED } else { RAIL_W })
        .bg(t.surface_1)
        .border_r_1()
        .border_color(t.line)
        .gap(px(ROW_GAP))
        .py(px(4.))
        .px(px(ROW_INSET))
        .when(collapsed, |rail| rail.items_center())
        .children(rendered)
}
