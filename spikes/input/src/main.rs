use std::ops::Range;
use std::time::{Duration, Instant};

use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::*;

const ROW_REFRESH: Duration = Duration::from_millis(50);
const VISIBLE_ROWS: usize = 12;

struct Terminal {
    focus: FocusHandle,
    rows: Vec<String>,
    marked: Option<Range<usize>>,
    lines: Vec<ShapedLine>,
    snapshot: Vec<SharedString>,
    snapshot_at: Instant,
}

impl Terminal {
    fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            rows: vec!["ostia spike: type here".to_string(), String::new()],
            marked: None,
            lines: Vec::new(),
            snapshot: Vec::new(),
            snapshot_at: Instant::now() - ROW_REFRESH,
        }
    }

    fn active(&self) -> &String {
        self.rows.last().expect("rows is never empty")
    }

    fn active_mut(&mut self) -> &mut String {
        self.rows.last_mut().expect("rows is never empty")
    }

    fn visible(&self) -> &[String] {
        &self.rows[self.rows.len().saturating_sub(VISIBLE_ROWS)..]
    }

    fn refresh_snapshot(&mut self) -> Vec<SharedString> {
        if self.snapshot_at.elapsed() >= ROW_REFRESH {
            let started = Instant::now();
            self.snapshot = self
                .visible()
                .iter()
                .map(|row| SharedString::from(row.clone()))
                .collect();
            self.snapshot_at = Instant::now();
            eprintln!("snapshot_us={}", started.elapsed().as_micros());
        }
        self.snapshot.clone()
    }

    fn push_row(&mut self, text: &str) {
        let last = self.rows.len() - 1;
        self.rows[last] = text.to_string();
        self.rows.push(String::new());
    }

    fn utf16_to_byte(text: &str, offset: usize) -> usize {
        let mut units = 0;
        for (index, ch) in text.char_indices() {
            if units >= offset {
                return index;
            }
            units += ch.len_utf16();
        }
        text.len()
    }

    fn byte_to_utf16(text: &str, offset: usize) -> usize {
        text[..offset].encode_utf16().count()
    }

    fn byte_range(&self, range: &Range<usize>) -> Range<usize> {
        let text = self.active();
        Self::utf16_to_byte(text, range.start)..Self::utf16_to_byte(text, range.end)
    }

    fn utf16_range(&self, range: &Range<usize>) -> Range<usize> {
        let text = self.active();
        Self::byte_to_utf16(text, range.start)..Self::byte_to_utf16(text, range.end)
    }
}

impl Focusable for Terminal {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl EntityInputHandler for Terminal {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let bytes = self.byte_range(&range);
        *adjusted_range = Some(self.utf16_range(&bytes));
        Some(self.active()[bytes].to_string())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.active().len();
        Some(UTF16Selection {
            range: self.utf16_range(&(end..end)),
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| self.utf16_range(range))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let bytes = range
            .map(|range| self.byte_range(&range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.active().len()..self.active().len());
        self.active_mut().replace_range(bytes, text);
        self.marked = None;
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        new_text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let bytes = range
            .map(|range| self.byte_range(&range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.active().len()..self.active().len());
        let start = bytes.start;
        self.active_mut().replace_range(bytes, new_text);
        self.marked = (!new_text.is_empty()).then(|| start..start + new_text.len());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        element_bounds: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let line = self.lines.last()?;
        let height = window.line_height();
        let byte = Self::utf16_to_byte(self.active(), range.start);
        let origin = point(
            element_bounds.origin.x + line.x_for_index(byte),
            element_bounds.origin.y + height * (self.lines.len() - 1) as f32,
        );
        Some(Bounds::new(origin, size(px(2.), height)))
    }

    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

struct TerminalElement {
    term: Entity<Terminal>,
    rows: Vec<SharedString>,
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some("terminal".into())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn a11y_role(&self) -> Option<Role> {
        Some(Role::Terminal)
    }

    fn write_a11y_info(&self, node: &mut accesskit::Node) {
        node.set_label("Spike terminal");
    }

    fn a11y_synthetic_children(&mut self, _: &mut (), builder: &mut A11ySubtreeBuilder) {
        for (index, row) in self.rows.iter().enumerate() {
            let mut node = accesskit::Node::new(Role::TextRun);
            node.set_value(row.to_string());
            node.set_character_lengths(
                row.chars()
                    .map(|ch| ch.len_utf8() as u8)
                    .collect::<Vec<u8>>(),
            );
            node.set_word_starts(vec![0u8]);
            let id = builder.synthetic_node_id(index);
            builder.push_child(id, node);
        }
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = (window.line_height() * VISIBLE_ROWS as f32).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut Window,
        _: &mut App,
    ) {
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.term.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.term.clone()),
            cx,
        );
        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let height = window.line_height();
        let (rows, marked) = {
            let term = self.term.read(cx);
            (term.visible().to_vec(), term.marked.clone())
        };
        let mut lines = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let is_active = index + 1 == rows.len();
            let mut runs = vec![TextRun {
                len: row.len(),
                font: style.font(),
                color: style.color,
                background_color: None,
                underline: None,
                strikethrough: None,
            }];
            if let (true, Some(marked)) = (is_active, marked.as_ref()) {
                let plain = TextRun {
                    len: 0,
                    ..runs[0].clone()
                };
                runs = vec![
                    TextRun {
                        len: marked.start,
                        ..plain.clone()
                    },
                    TextRun {
                        len: marked.end - marked.start,
                        underline: Some(UnderlineStyle {
                            color: Some(style.color),
                            thickness: px(1.),
                            wavy: false,
                        }),
                        ..plain.clone()
                    },
                    TextRun {
                        len: row.len() - marked.end,
                        ..plain
                    },
                ]
                .into_iter()
                .filter(|run| run.len > 0)
                .collect();
            }
            let line = window.text_system().shape_line(
                SharedString::from(row.clone()),
                font_size,
                &runs,
                None,
            );
            let origin = point(bounds.origin.x, bounds.origin.y + height * index as f32);
            line.paint(origin, height, TextAlign::Left, None, window, cx)
                .expect("paint row");
            lines.push(line);
        }
        self.term.update(cx, |term, _| term.lines = lines);
    }
}

struct Spike {
    input: Entity<InputState>,
    term: Entity<Terminal>,
    presses: u32,
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.term.update(cx, |term, _| term.refresh_snapshot());
        let term = self.term.clone();
        let spike = cx.entity();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .child(Input::new(&self.input))
            .child(
                div()
                    .id("terminal-frame")
                    .track_focus(&self.term.read(cx).focus)
                    .on_key_down({
                        let term = self.term.clone();
                        move |event, _, cx| {
                            if event.keystroke.key == "enter" {
                                term.update(cx, |term, cx| {
                                    let text = term.active().clone();
                                    term.push_row(&text);
                                    cx.notify();
                                });
                            }
                        }
                    })
                    .child(TerminalElement { term, rows }),
            )
            .child(
                Button::new("press")
                    .label(format!("Pressed {}", self.presses))
                    .on_click(move |_, _, cx| {
                        spike.update(cx, |spike, cx| {
                            spike.presses += 1;
                            let line = format!("button pressed {}", spike.presses);
                            spike.term.update(cx, |term, cx| {
                                term.push_row(&line);
                                cx.notify();
                            });
                            cx.notify();
                        });
                    }),
            )
            .child(div().child(format!("window {:?}", window.bounds().size)))
    }
}

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        let (_, spike) = gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
            let input = cx.new(|cx| InputState::new(window, cx));
            let term = cx.new(Terminal::new);
            let focus = term.read(cx).focus.clone();
            window.focus(&focus, cx);
            cx.new(|_| Spike {
                input,
                term,
                presses: 0,
            })
        })
        .expect("open window");
        cx.activate(true);
        spike.update(cx, |_, _| {});
    });
}
