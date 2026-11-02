use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use gpui_kit::component::{h_resizable, resizable_panel, v_resizable};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Context, ElementId, Entity, EntityId, Render, Role, Subscription,
    TestSupportExt as _, Window, div, px,
};
use ostia_model::layout::focus_direction::keyboard_pane_id;
use ostia_model::layout::tree::{all_panes, first_tab_pane_id, shown_tab, slot_count, slot_key};
use ostia_model::layout::types::{Direction, LayoutNode, SplitNode, TabNode};
use ostia_model::workspaces::layout_store::WorkspaceLayout;
use ostia_park::ParkedRecord;
use ostia_ui::components::{Button, ButtonVariant, EmptyState, IconName};
use ostia_ui::theme::UiTheme;
use ostia_ui::tokens::{TextStep, UiText};

use super::Terminals;
use super::bridge::Bridge;
use super::pane::{PaneEvent, PaneView};
use super::tab_strip::{StripContext, render_strip};
use super::window_stores::WindowStores;

const EMPTY_TITLE: &str = "Empty workspace";
const EMPTY_BODY: &str = "Open a terminal to start.";
const NO_WORKSPACES: &str = "No workspaces";
const NEW_TERMINAL: &str = "New terminal";
const NEW_WORKSPACE: &str = "New workspace";

struct Surface {
    view: Entity<PaneView>,
    _events: Subscription,
}

pub struct WorkArea {
    stores: WindowStores,
    bridge: Bridge,
    terminals: Terminals,
    surfaces: HashMap<String, Surface>,
    focused: Option<String>,
    _subscriptions: Vec<Subscription>,
}

fn parked_line(records: &[ParkedRecord]) -> Option<String> {
    let titles: Vec<&str> = records.iter().map(|record| record.title.as_str()).collect();
    match titles.len() {
        0 => None,
        1 => Some(format!("1 parked session: {}", titles.join(", "))),
        count => Some(format!("{count} parked sessions: {}", titles.join(", "))),
    }
}

impl WorkArea {
    pub fn new(
        stores: WindowStores,
        bridge: Bridge,
        terminals: Terminals,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscriptions = vec![
            cx.observe_in(&stores.layouts, window, |this, _, window, cx| {
                this.sync_surfaces(window, cx);
            }),
            cx.observe_in(&stores.workspaces, window, |this, _, window, cx| {
                this.sync_surfaces(window, cx);
            }),
        ];
        bridge.park.notify_on_change(cx);
        let mut area = Self {
            stores,
            bridge,
            terminals,
            surfaces: HashMap::new(),
            focused: None,
            _subscriptions: subscriptions,
        };
        area.sync_surfaces(window, cx);
        area
    }

    pub fn surface_id(&self, pane_id: &str) -> Option<EntityId> {
        self.surfaces
            .get(pane_id)
            .map(|surface| surface.view.entity_id())
    }

    pub fn parked_in_active_workspace(&self, cx: &App) -> Vec<ParkedRecord> {
        self.stores
            .workspaces
            .read(cx)
            .state()
            .active_workspace_id()
            .map(|workspace| self.bridge.park.list(workspace))
            .unwrap_or_default()
    }

    fn sync_surfaces(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted = self.wanted_panes(cx);
        let live: HashSet<&str> = wanted.iter().map(|pane| pane.pane_id.as_str()).collect();
        self.surfaces
            .retain(|pane_id, _| live.contains(pane_id.as_str()));
        for pane in &wanted {
            if !self.surfaces.contains_key(&pane.pane_id) {
                let surface = self.new_surface(pane, cx);
                self.surfaces.insert(pane.pane_id.clone(), surface);
            }
        }
        self.apply_active(window, cx);
        cx.notify();
    }

    fn wanted_panes(&self, cx: &App) -> Vec<WantedPane> {
        let layouts = self.stores.layouts.read(cx).state();
        layouts
            .workspace_ids()
            .filter_map(|workspace| layouts.layout(workspace).map(|layout| (workspace, layout)))
            .flat_map(|(workspace, layout)| {
                all_panes(&layout.root)
                    .into_iter()
                    .map(move |pane| WantedPane {
                        workspace_id: workspace.to_owned(),
                        pane_id: pane.id.clone(),
                        cwd: pane.cwd.clone(),
                    })
            })
            .collect()
    }

    fn new_surface(&self, pane: &WantedPane, cx: &mut Context<Self>) -> Surface {
        let terminals = self.terminals.clone();
        let view = cx.new(|cx| PaneView::new(&pane.pane_id, pane.cwd.as_deref(), &terminals, cx));
        let workspace = pane.workspace_id.clone();
        let pane_id = pane.pane_id.clone();
        let events = cx.subscribe(&view, move |this, _, event, cx| {
            this.on_pane_event(&workspace, &pane_id, event, cx);
        });
        Surface {
            view,
            _events: events,
        }
    }

    fn apply_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let active = self.active_layout(cx);
        let target = active.as_ref().map(|(_, layout)| {
            keyboard_pane_id(
                &layout.root,
                &layout.active_pane_id,
                layout.zoomed_pane_id.as_deref(),
            )
        });
        let split = active
            .as_ref()
            .is_some_and(|(_, layout)| slot_count(&layout.root) > 1);
        let moved = target != self.focused;
        self.focused = target.clone();
        for (pane_id, surface) in &self.surfaces {
            let is_target = target.as_deref() == Some(pane_id.as_str());
            surface.view.update(cx, |view, cx| {
                view.set_shown_state(split && !is_target, is_target && moved, window, cx);
            });
        }
    }

    fn active_layout(&self, cx: &App) -> Option<(String, WorkspaceLayout)> {
        let workspace = self
            .stores
            .workspaces
            .read(cx)
            .state()
            .active_workspace_id()?
            .to_owned();
        let layout = self
            .stores
            .layouts
            .read(cx)
            .state()
            .layout(&workspace)?
            .clone();
        Some((workspace, layout))
    }

    fn on_pane_event(
        &mut self,
        workspace: &str,
        pane_id: &str,
        event: &PaneEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            PaneEvent::Activated => self.stores.focus_pane(workspace, pane_id, cx),
            PaneEvent::ShellExited => self.stores.close_pane(workspace, pane_id, cx),
            PaneEvent::TitleChanged(title) => {
                self.stores.layouts.update(cx, |store, cx| {
                    store.change(cx, |layouts| layouts.set_title(workspace, pane_id, title))
                });
            }
        }
    }

    fn render_pane_body(&self, pane_id: &str) -> AnyElement {
        match self.surfaces.get(pane_id) {
            Some(surface) => surface.view.clone().into_any_element(),
            None => div().into_any_element(),
        }
    }

    fn render_slot(
        &self,
        tabs: &[TabNode],
        shown: Option<&TabNode>,
        context: &StripContext,
        cx: &App,
    ) -> AnyElement {
        let Some(shown) = shown else {
            return div().into_any_element();
        };
        let body = match shown {
            TabNode::Pane(pane) => self.render_pane_body(&pane.id),
            TabNode::Split(split) => self.render_split(split, context, cx),
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(render_strip(
                tabs,
                shown.id(),
                first_tab_pane_id(shown),
                context,
                cx,
            ))
            .child(div().relative().flex_1().min_h_0().child(body))
            .into_any_element()
    }

    fn render_split(&self, split: &Arc<SplitNode>, context: &StripContext, cx: &App) -> AnyElement {
        let keys: Vec<&str> = split.children.iter().map(slot_key).collect();
        let group_id = ElementId::Name(format!("split-{}-{}", split.id, keys.join("+")).into());
        let total: f64 = split.sizes.iter().sum();
        let stores = context.stores.clone();
        let workspace = context.workspace_id.clone();
        let split_id = split.id.clone();
        let group = match split.direction {
            Direction::Horizontal => h_resizable(group_id),
            Direction::Vertical => v_resizable(group_id),
        }
        .on_resize(move |state, _, cx| {
            let sizes: Vec<f64> = state
                .read(cx)
                .sizes()
                .iter()
                .map(|size| f64::from(size.as_f32()))
                .collect();
            stores.layouts.update(cx, |store, cx| {
                store.change(cx, |layouts| layouts.resize(&workspace, &split_id, &sizes))
            });
        });
        split
            .children
            .iter()
            .enumerate()
            .fold(group, |group, (index, child)| {
                let size = split.sizes.get(index).copied().unwrap_or(1.0);
                let share = if total > 0.0 { size / total } else { 1.0 };
                group.child(
                    resizable_panel()
                        .flex_grow(share as f32)
                        .flex_basis(px(0.))
                        .child(self.render_node(child, context, cx)),
                )
            })
            .into_any_element()
    }

    fn render_node(&self, node: &LayoutNode, context: &StripContext, cx: &App) -> AnyElement {
        match node {
            LayoutNode::Pane(pane) => {
                let tab = TabNode::Pane(pane.clone());
                self.render_slot(std::slice::from_ref(&tab), Some(&tab), context, cx)
            }
            LayoutNode::Tabs(tabs) => {
                self.render_slot(&tabs.children, shown_tab(tabs), context, cx)
            }
            LayoutNode::Split(split) => self.render_split(split, context, cx),
        }
    }

    fn render_empty_workspace(&self, cx: &mut Context<Self>) -> AnyElement {
        let t = *cx.tokens();
        let stores = self.stores.clone();
        let parked = parked_line(&self.parked_in_active_workspace(cx));
        let state = EmptyState::surface()
            .title(EMPTY_TITLE)
            .desc(EMPTY_BODY)
            .action(
                Button::new("empty-new-terminal")
                    .label(NEW_TERMINAL)
                    .icon(IconName::TerminalWindow)
                    .on_click(move |_, _, cx| stores.new_terminal(cx)),
            );
        match parked {
            Some(line) => state
                .action(
                    div()
                        .id("parked-sessions")
                        .role(Role::Label)
                        .aria_label(line.clone())
                        .test_support()
                        .text_color(t.fg_muted)
                        .ui_text(TextStep::Sm, cx)
                        .child(line),
                )
                .into_any_element(),
            None => state.into_any_element(),
        }
    }

    fn render_no_workspace(&self) -> AnyElement {
        let stores = self.stores.clone();
        EmptyState::surface()
            .title(NO_WORKSPACES)
            .action(
                Button::new("empty-new-workspace")
                    .label(NEW_WORKSPACE)
                    .variant(ButtonVariant::Default)
                    .on_click(move |_, _, cx| stores.new_workspace(cx)),
            )
            .into_any_element()
    }
}

struct WantedPane {
    workspace_id: String,
    pane_id: String,
    cwd: Option<String>,
}

impl Render for WorkArea {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_workspace = self
            .stores
            .workspaces
            .read(cx)
            .state()
            .active_workspace_id()
            .is_some();
        if !has_workspace {
            return self.render_no_workspace();
        }
        let Some((workspace_id, layout)) = self.active_layout(cx) else {
            return self.render_empty_workspace(cx);
        };
        let context = StripContext {
            stores: self.stores.clone(),
            workspace_id,
            active_pane_id: layout.active_pane_id.clone(),
        };
        self.render_node(&layout.root, &context, cx)
    }
}
