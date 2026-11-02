use std::rc::Rc;

use gpui_kit::{
    App, BorderStyle, Bounds, Element, ElementId, FontWeight, GlobalElementId, Hsla,
    InspectorElementId, IntoElement, LayoutId, Pixels, SharedString, Size, Style, TextAlign,
    TextRun, UnderlineStyle, Window, fill, font, outline, point, px, relative, rgb, size,
};
use ostia_ui::tokens::{FONT_TERMINAL, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT};

use super::frame::{Frame, Rgb};

const CURSOR_ALPHA: f32 = 0.6;
const FALLBACK_CELL_WIDTH: f32 = 7.8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grid {
    pub cols: u16,
    pub rows: u16,
    pub cell_width: u32,
    pub cell_height: u32,
}

pub fn grid_for(space: Size<Pixels>, cell_width: Pixels, line_height: Pixels) -> Option<Grid> {
    let cols = (f32::from(space.width) / f32::from(cell_width)).floor();
    let rows = (f32::from(space.height) / f32::from(line_height)).floor();
    if cols < 1. || rows < 1. {
        return None;
    }
    Some(Grid {
        cols: cols as u16,
        rows: rows as u16,
        cell_width: f32::from(cell_width).round() as u32,
        cell_height: f32::from(line_height).round() as u32,
    })
}

pub fn line_height() -> Pixels {
    px((TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT).round())
}

pub type GridHandler = Rc<dyn Fn(Grid, &mut Window, &mut App)>;

pub struct TerminalElement {
    pub frame: Rc<Frame>,
    pub focused: bool,
    pub current_grid: Option<Grid>,
    pub on_grid: GridHandler,
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
    type PrepaintState = Pixels;

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
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let font_id = window.text_system().resolve_font(&font(FONT_TERMINAL));
        let cell_width = window
            .text_system()
            .advance(font_id, px(TERMINAL_FONT_SIZE), 'm')
            .map_or(px(FALLBACK_CELL_WIDTH), |advance| advance.width);
        let grid = grid_for(bounds.size, cell_width, line_height());
        if let Some(grid) = grid.filter(|grid| Some(*grid) != self.current_grid) {
            let on_grid = self.on_grid.clone();
            window.defer(cx, move |window, cx| on_grid(grid, window, cx));
        }
        cell_width
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        cell_width: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let cell_width = *cell_width;
        let font_size = px(TERMINAL_FONT_SIZE);
        let line_height = line_height();
        let regular = font(FONT_TERMINAL);
        let mut bold = regular.clone();
        bold.weight = FontWeight::BOLD;
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
                let foreground = color(span.fg);
                let run = TextRun {
                    len: span.text.len(),
                    font: if span.bold {
                        bold.clone()
                    } else {
                        regular.clone()
                    },
                    color: foreground,
                    background_color: None,
                    underline: span.underline.then_some(UnderlineStyle {
                        thickness: px(1.),
                        color: Some(foreground),
                        wavy: false,
                    }),
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
            let cell = Bounds::new(
                point(
                    bounds.origin.x + cell_width * f32::from(cursor.col),
                    bounds.origin.y + line_height * f32::from(cursor.row),
                ),
                size(cell_width, line_height),
            );
            let cursor_color = color(self.frame.cursor_color);
            if self.focused {
                window.paint_quad(fill(cell, cursor_color.opacity(CURSOR_ALPHA)));
            } else {
                window.paint_quad(outline(cell, cursor_color, BorderStyle::Solid));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_never_reports_a_zero_size() {
        assert!(grid_for(size(px(0.), px(100.)), px(8.), px(15.)).is_none());
        assert!(grid_for(size(px(100.), px(5.)), px(8.), px(15.)).is_none());
    }

    #[test]
    fn grid_counts_whole_cells() {
        let grid = grid_for(size(px(805.), px(310.)), px(8.), px(15.)).expect("grid");
        assert_eq!((grid.cols, grid.rows), (100, 20));
    }
}
