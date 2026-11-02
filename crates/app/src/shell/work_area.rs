use gpui_kit::component::{h_resizable, resizable_panel};
use gpui_kit::prelude::*;
use gpui_kit::{Context, Entity, Render, Subscription, Window, div};
use ostia_ui::components::EmptyState;

use super::pane::{PaneEvent, PaneView};

const LIVE_PANES: usize = 2;

pub struct WorkArea {
    panes: Vec<Entity<PaneView>>,
    active: usize,
    _subscriptions: Vec<Subscription>,
}

impl WorkArea {
    pub fn new(shell_argv: &[String], window: &mut Window, cx: &mut Context<Self>) -> Self {
        let panes: Vec<Entity<PaneView>> = (0..LIVE_PANES)
            .map(|index| {
                let show_status = index == 0;
                cx.new(|cx| PaneView::new(index, shell_argv, show_status, cx))
            })
            .collect();
        let subscriptions = panes
            .iter()
            .map(|pane| cx.subscribe_in(pane, window, Self::on_pane_event))
            .collect();
        let mut area = Self {
            panes,
            active: 0,
            _subscriptions: subscriptions,
        };
        area.sync_active(window, cx);
        area
    }

    pub fn pane_count(&self) -> usize {
        self.panes.len()
    }

    fn sync_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let split = self.panes.len() > 1;
        for (index, pane) in self.panes.iter().enumerate() {
            let active = index == self.active;
            pane.update(cx, |pane, cx| pane.set_active(active, split, window, cx));
        }
        cx.notify();
    }

    fn on_pane_event(
        &mut self,
        pane: &Entity<PaneView>,
        event: &PaneEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self.panes.iter().position(|candidate| candidate == pane) else {
            return;
        };
        match event {
            PaneEvent::Activated => self.active = index,
            PaneEvent::Closed => {
                self.panes.remove(index);
                self.active = self.active.min(self.panes.len().saturating_sub(1));
            }
        }
        self.sync_active(window, cx);
    }
}

impl Render for WorkArea {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        if self.panes.is_empty() {
            return EmptyState::surface()
                .title("Empty workspace")
                .desc("New terminals need the panes core, which is not ported.")
                .into_any_element();
        }
        if let [only] = self.panes.as_slice() {
            return div().size_full().child(only.clone()).into_any_element();
        }
        self.panes
            .iter()
            .fold(h_resizable("work-split"), |group, pane| {
                group.child(resizable_panel().child(pane.clone()))
            })
            .into_any_element()
    }
}
