use gpui_kit::component::ThemeStyled as _;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{App, FocusHandle, ParentElement, Styled, Window};

pub trait FocusRing: Styled + ParentElement + FluentBuilder + Sized {
    fn focus_ring(self, handle: &FocusHandle, window: &Window, cx: &App) -> Self {
        self.when(handle.is_focused(window), |element| {
            element.focus_ring_style(window, cx)
        })
    }
}

impl<T: Styled + ParentElement + FluentBuilder + Sized> FocusRing for T {}
