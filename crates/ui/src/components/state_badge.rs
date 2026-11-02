use gpui_kit::prelude::*;
use gpui_kit::{
    Animation, AnimationExt as _, App, ElementId, IntoElement, RenderOnce, Window, div,
};

use crate::icons::{IconName, IconSize, icon};
use crate::theme::UiTheme;
use crate::tokens::{BREATHE_MIN_OPACITY, MOTION_BREATHE};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceState {
    Idle,
    Working,
    Waiting,
    Error,
    Done,
}

impl WorkspaceState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Working => "Working",
            Self::Waiting => "Waiting",
            Self::Error => "Failed",
            Self::Done => "Done",
        }
    }

    fn icon(self) -> Option<IconName> {
        match self {
            Self::Idle => None,
            Self::Working => Some(IconName::CircleNotch),
            Self::Waiting => Some(IconName::BellRinging),
            Self::Error => Some(IconName::WarningCircle),
            Self::Done => Some(IconName::CheckCircle),
        }
    }
}

pub fn breathe_opacity(delta: f32) -> f32 {
    let wave = (1. - (delta * std::f32::consts::TAU).cos()) / 2.;
    1. - (1. - BREATHE_MIN_OPACITY) * wave
}

#[derive(IntoElement)]
pub struct StateBadge {
    id: ElementId,
    state: WorkspaceState,
}

impl StateBadge {
    pub fn new(id: impl Into<ElementId>, state: WorkspaceState) -> Self {
        Self {
            id: id.into(),
            state,
        }
    }
}

impl RenderOnce for StateBadge {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = *cx.tokens();
        let color = match self.state {
            WorkspaceState::Idle | WorkspaceState::Working => t.brand,
            WorkspaceState::Waiting => t.warn_fg,
            WorkspaceState::Error => t.attn,
            WorkspaceState::Done => t.ok,
        };
        let reduce = cx.reduce_motion();
        let working = self.state == WorkspaceState::Working;
        let id = self.id;
        div().children(self.state.icon().map(|name| {
            let badge = icon(name, IconSize::Badge, color);
            if working && !reduce {
                badge
                    .with_animation(
                        id,
                        Animation::new(MOTION_BREATHE).repeat(),
                        move |badge, delta| badge.text_color(color.opacity(breathe_opacity(delta))),
                    )
                    .into_any_element()
            } else {
                badge.into_any_element()
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breathe_runs_between_the_token_and_full_opacity() {
        assert!((breathe_opacity(0.) - 1.).abs() < 0.001);
        assert!((breathe_opacity(0.5) - BREATHE_MIN_OPACITY).abs() < 0.001);
        assert!((breathe_opacity(1.) - 1.).abs() < 0.001);
    }

    #[test]
    fn idle_has_no_badge_and_each_other_state_has_a_shape() {
        assert!(WorkspaceState::Idle.icon().is_none());
        assert_eq!(WorkspaceState::Waiting.icon(), Some(IconName::BellRinging));
        assert_eq!(WorkspaceState::Error.icon(), Some(IconName::WarningCircle));
    }
}
