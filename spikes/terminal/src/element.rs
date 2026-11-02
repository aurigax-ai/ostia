use std::rc::Rc;

use gpui_kit::{
    App, Bounds, Element, ElementId, FontWeight, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, Pixels, SharedString, Style, TextAlign, TextRun, Window, fill, font,
    point, px, relative, rgb, size,
};

use crate::frame::{Frame, Rgb};

pub const FONT_FAMILY: &str = "DejaVu Sans Mono";
pub const FONT_SIZE: f32 = 9.0;
pub const LINE_HEIGHT: f32 = 12.0;

pub struct TerminalElement {
    pub frame: Rc<Frame>,
    pub on_paint: Rc<dyn Fn()>,
}

fn color(value: Rgb) -> Hsla {
    rgb(value.packed()).into()
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let font_size = px(FONT_SIZE);
        let line_height = px(LINE_HEIGHT);
        let regular = font(FONT_FAMILY);
        let mut bold = regular.clone();
        bold.weight = FontWeight::BOLD;
        let font_id = window.text_system().resolve_font(&regular);
        let cell_width = window
            .text_system()
            .advance(font_id, font_size, 'm')
            .map(|advance| advance.width)
            .unwrap_or(px(5.4));

        window.paint_quad(fill(bounds, color(self.frame.background)));
        for (row, spans) in self.frame.lines.iter().enumerate() {
            let top = bounds.origin.y + line_height * row as f32;
            for span in spans {
                let left = bounds.origin.x + cell_width * f32::from(span.col);
                if let Some(background) = span.bg {
                    window.paint_quad(fill(
                        Bounds::new(
                            point(left, top),
                            size(cell_width * f32::from(span.cells), line_height),
                        ),
                        color(background),
                    ));
                }
                if span.text.trim().is_empty() {
                    continue;
                }
                let run = TextRun {
                    len: span.text.len(),
                    font: if span.bold {
                        bold.clone()
                    } else {
                        regular.clone()
                    },
                    color: color(span.fg),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let shaped = window.text_system().shape_line(
                    SharedString::from(span.text.clone()),
                    font_size,
                    &[run],
                    None,
                );
                let _ = shaped.paint(
                    point(left, top),
                    line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
        }
        if let Some(cursor) = self.frame.cursor {
            let mut cursor_color = color(self.frame.foreground);
            cursor_color.a = 0.6;
            window.paint_quad(fill(
                Bounds::new(
                    point(
                        bounds.origin.x + cell_width * f32::from(cursor.col),
                        bounds.origin.y + line_height * f32::from(cursor.row),
                    ),
                    size(cell_width, line_height),
                ),
                cursor_color,
            ));
        }
        (self.on_paint)();
    }
}
