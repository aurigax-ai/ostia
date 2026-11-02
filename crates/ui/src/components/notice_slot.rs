use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, App, Context, IntoElement, Render, Window, div,
};

use crate::tokens::MOTION_BASE_EXIT;

pub type NoticeBuilder = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

enum Phase {
    Empty,
    Shown(NoticeBuilder),
    Leaving(NoticeBuilder),
}

pub struct NoticeSlot {
    phase: Phase,
    exit: u64,
}

impl NoticeSlot {
    pub fn new() -> Self {
        Self {
            phase: Phase::Empty,
            exit: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self.phase, Phase::Empty)
    }

    pub fn is_leaving(&self) -> bool {
        matches!(self.phase, Phase::Leaving(_))
    }

    pub fn show(&mut self, notice: NoticeBuilder, cx: &mut Context<Self>) {
        self.exit += 1;
        self.phase = Phase::Shown(notice);
        cx.notify();
    }

    pub fn hide(&mut self, cx: &mut Context<Self>) {
        let Phase::Shown(notice) = std::mem::replace(&mut self.phase, Phase::Empty) else {
            return;
        };
        self.exit += 1;
        if cx.reduce_motion() {
            cx.notify();
            return;
        }
        self.phase = Phase::Leaving(notice);
        let exit = self.exit;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(MOTION_BASE_EXIT).await;
            let _ = this.update(cx, |slot, cx| slot.finish_exit(exit, cx));
        })
        .detach();
        cx.notify();
    }

    fn finish_exit(&mut self, exit: u64, cx: &mut Context<Self>) {
        if self.exit == exit && self.is_leaving() {
            self.phase = Phase::Empty;
            cx.notify();
        }
    }
}

impl Default for NoticeSlot {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for NoticeSlot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match &self.phase {
            Phase::Empty => div().into_any_element(),
            Phase::Shown(notice) => div().child(notice(window, cx)).into_any_element(),
            Phase::Leaving(notice) => div()
                .relative()
                .child(notice(window, cx))
                .child(div().absolute().top_0().left_0().size_full().occlude())
                .with_animation(
                    ("notice-slot-exit", self.exit),
                    Animation::new(MOTION_BASE_EXIT),
                    |slot, delta| slot.opacity(1. - delta),
                )
                .into_any_element(),
        }
    }
}
