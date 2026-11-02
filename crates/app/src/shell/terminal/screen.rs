use anyhow::Result;
use libghostty_vt::render::{CellIterator, RowIterator};
use libghostty_vt::screen::CellWide;
use libghostty_vt::style::{RgbColor, Underline};
use libghostty_vt::{RenderState, Terminal, TerminalOptions};

use ostia_ui::color::Rgba8;
use ostia_ui::theme::ColorScheme;

use super::frame::{Cursor, Frame, Rgb, Span};

pub struct Screen {
    terminal: Terminal<'static, 'static>,
    render_state: RenderState<'static>,
    rows: RowIterator<'static>,
    cells: CellIterator<'static>,
}

impl Screen {
    pub fn new(cols: u16, rows: u16, max_scrollback: usize) -> Result<Self> {
        Ok(Self {
            terminal: Terminal::new(TerminalOptions {
                cols,
                rows,
                max_scrollback,
            })?,
            render_state: RenderState::new()?,
            rows: RowIterator::new()?,
            cells: CellIterator::new()?,
        })
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
    }

    pub fn resize(
        &mut self,
        cols: u16,
        rows: u16,
        cell_width: u32,
        cell_height: u32,
    ) -> Result<()> {
        self.terminal.resize(cols, rows, cell_width, cell_height)?;
        Ok(())
    }

    pub fn apply_scheme(&mut self, scheme: &ColorScheme) -> Result<()> {
        let mut palette = self.terminal.default_color_palette()?;
        for (slot, color) in palette.0.iter_mut().zip(scheme.ansi()) {
            *slot = rgb_color(color);
        }
        self.terminal
            .set_default_fg_color(Some(rgb_color(scheme.foreground)))?
            .set_default_bg_color(Some(rgb_color(scheme.background)))?
            .set_default_cursor_color(Some(rgb_color(scheme.cursor)))?
            .set_default_color_palette(Some(palette))?;
        Ok(())
    }

    pub fn title(&self) -> String {
        self.terminal.title().map(str::to_owned).unwrap_or_default()
    }

    pub fn frame(&mut self) -> Result<Frame> {
        let snapshot = self.render_state.update(&self.terminal)?;
        let colors = snapshot.colors()?;
        let background = rgb(colors.background);
        let foreground = rgb(colors.foreground);
        let cursor_color = snapshot.cursor_color()?.map_or(foreground, rgb);
        let cursor = snapshot
            .cursor_viewport()?
            .filter(|_| snapshot.cursor_visible().unwrap_or(false))
            .map(|cursor| Cursor {
                col: cursor.x,
                row: cursor.y,
            });
        let mut lines = Vec::new();
        let mut row_iteration = self.rows.update(&snapshot)?;
        while let Some(row) = row_iteration.next() {
            let mut spans: Vec<Span> = Vec::new();
            let mut cell_iteration = self.cells.update(row)?;
            let mut col: u16 = 0;
            while let Some(cell) = cell_iteration.next() {
                let this_col = col;
                col += 1;
                let wide = cell.raw_cell()?.wide()?;
                if matches!(wide, CellWide::SpacerTail | CellWide::SpacerHead) {
                    continue;
                }
                let style = cell.style()?;
                let mut fg = cell.fg_color()?.map_or(foreground, rgb);
                let mut bg = cell.bg_color()?.map(rgb);
                if style.inverse {
                    let swapped = bg.unwrap_or(background);
                    bg = Some(fg);
                    fg = swapped;
                }
                let underline = !matches!(style.underline, Underline::None);
                let graphemes = cell.graphemes()?;
                let text: String = if graphemes.is_empty() {
                    " ".to_owned()
                } else {
                    graphemes.into_iter().collect()
                };
                let width: u16 = if matches!(wide, CellWide::Wide) { 2 } else { 1 };
                let joins = spans.last().is_some_and(|last| {
                    last.col + last.cells == this_col
                        && last.fg == fg
                        && last.bg == bg
                        && last.bold == style.bold
                        && last.underline == underline
                });
                if joins {
                    if let Some(last) = spans.last_mut() {
                        last.text.push_str(&text);
                        last.cells += width;
                    }
                } else {
                    spans.push(Span {
                        col: this_col,
                        cells: width,
                        text,
                        fg,
                        bg,
                        bold: style.bold,
                        underline,
                    });
                }
            }
            lines.push(spans);
        }
        Ok(Frame {
            lines,
            cursor,
            background,
            foreground,
            cursor_color,
        })
    }
}

fn rgb(color: RgbColor) -> Rgb {
    Rgb {
        r: color.r,
        g: color.g,
        b: color.b,
    }
}

fn rgb_color(color: Rgba8) -> RgbColor {
    RgbColor {
        r: color.r,
        g: color.g,
        b: color.b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_text(frame: &Frame, row: usize) -> String {
        frame.lines[row]
            .iter()
            .map(|span| span.text.as_str())
            .collect()
    }

    #[test]
    fn written_bytes_reach_the_frame() {
        let mut screen = Screen::new(20, 4, 100).expect("screen");
        screen.feed(b"one\r\ntwo");
        let frame = screen.frame().expect("frame");
        assert!(row_text(&frame, 0).starts_with("one"));
        assert!(row_text(&frame, 1).starts_with("two"));
    }

    #[test]
    fn scheme_colors_set_the_default_background() {
        let mut screen = Screen::new(20, 4, 100).expect("screen");
        let scheme = ostia_ui::theme::color_schemes().first().expect("scheme");
        screen.apply_scheme(scheme).expect("apply");
        let frame = screen.frame().expect("frame");
        let expected = scheme.background;
        assert_eq!(
            (frame.background.r, frame.background.g, frame.background.b),
            (expected.r, expected.g, expected.b)
        );
    }

    #[test]
    fn title_follows_the_escape_sequence() {
        let mut screen = Screen::new(20, 4, 100).expect("screen");
        screen.feed(b"\x1b]2;build\x07");
        assert_eq!(screen.title(), "build");
    }
}
