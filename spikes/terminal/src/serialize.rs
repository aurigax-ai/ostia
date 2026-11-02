use anyhow::{Result, anyhow};
use libghostty_vt::fmt::Format;
use libghostty_vt::screen::RowSemanticPrompt;
use libghostty_vt::selection::{FormatOptions, Selection};
use libghostty_vt::terminal::{Point, PointCoordinate};

use crate::screen::Screen;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PromptMark {
    pub row: u32,
}

pub fn all_text(screen: &Screen) -> Result<String> {
    let terminal = screen.terminal();
    let selection = terminal
        .select_all()?
        .ok_or_else(|| anyhow!("nothing to select"))?;
    format(screen, &selection)
}

pub fn row_range_text(screen: &Screen, first_row: u32, last_row: u32) -> Result<String> {
    let terminal = screen.terminal();
    let last_col = terminal.cols()?.saturating_sub(1);
    let start = terminal.grid_ref(Point::Screen(PointCoordinate { x: 0, y: first_row }))?;
    let end = terminal.grid_ref(Point::Screen(PointCoordinate {
        x: last_col,
        y: last_row,
    }))?;
    format(screen, &Selection::new(start, end, false))
}

pub fn prompt_marks(screen: &Screen) -> Result<Vec<PromptMark>> {
    let terminal = screen.terminal();
    let total = u32::try_from(terminal.total_rows()?)?;
    let mut marks = Vec::new();
    for row in 0..total {
        let grid_ref = terminal.grid_ref(Point::Screen(PointCoordinate { x: 0, y: row }))?;
        if grid_ref.row()?.semantic_prompt()? == RowSemanticPrompt::Prompt {
            marks.push(PromptMark { row });
        }
    }
    Ok(marks)
}

pub fn output_after_mark(screen: &Screen, mark: PromptMark) -> Result<Option<String>> {
    let terminal = screen.terminal();
    let grid_ref = terminal.grid_ref(Point::Screen(PointCoordinate { x: 0, y: mark.row }))?;
    match terminal.select_output(grid_ref)? {
        Some(selection) => Ok(Some(format(screen, &selection)?)),
        None => Ok(None),
    }
}

fn format(screen: &Screen, selection: &Selection<'_>) -> Result<String> {
    let options = FormatOptions::new()
        .with_emit_format(Format::Plain)
        .with_unwrap(true)
        .with_trim(true)
        .with_selection(selection);
    let bytes = screen
        .terminal()
        .format_selection_alloc(None, options)?
        .ok_or_else(|| anyhow!("empty selection"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
