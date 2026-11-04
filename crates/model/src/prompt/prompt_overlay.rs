use ostia_contract::prompt_settings::PromptStyle;

pub const MIN_INPUT_COLS: i64 = 12;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptPlacementInput {
    pub input_line: i64,
    pub input_col: i64,
    pub viewport_y: i64,
    pub rows: i64,
    pub cols: i64,
    pub right_prompt_col: Option<i64>,
    pub style: PromptStyle,
    pub same_line: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptPlacement {
    pub row: i64,
    pub col: i64,
    pub end_col: i64,
    pub chips_row: Option<i64>,
    pub rows_below: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellMetrics {
    pub width: f64,
    pub height: f64,
    pub left: f64,
    pub top: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellBox {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

pub fn place_prompt(input: &PromptPlacementInput) -> Option<PromptPlacement> {
    let PromptPlacementInput {
        input_line,
        input_col,
        viewport_y,
        rows,
        cols,
        right_prompt_col,
        style,
        same_line,
    } = *input;
    if rows <= 0 || cols <= 0 {
        return None;
    }
    let row = input_line - viewport_y;
    if row < 0 || row >= rows {
        return None;
    }
    let rows_below = rows - 1 - row;
    if style == PromptStyle::Ostia && same_line {
        return Some(PromptPlacement {
            row,
            col: 0,
            end_col: cols,
            chips_row: None,
            rows_below,
        });
    }
    let col = input_col.max(0).min(cols - 1);
    if style == PromptStyle::Ostia {
        return Some(PromptPlacement {
            row,
            col,
            end_col: cols,
            chips_row: if row == 0 { None } else { Some(row - 1) },
            rows_below,
        });
    }
    let end_col = match right_prompt_col {
        Some(right) if right - col >= MIN_INPUT_COLS => right.min(cols),
        _ => cols,
    };
    Some(PromptPlacement {
        row,
        col,
        end_col,
        chips_row: None,
        rows_below,
    })
}

pub fn right_prompt_start(cells: &[&str], from: i64) -> Option<i64> {
    let start = usize::try_from(from.max(0)).unwrap_or(usize::MAX);
    cells
        .iter()
        .enumerate()
        .skip(start)
        .find(|(_, cell)| !cell.is_empty() && **cell != " ")
        .and_then(|(index, _)| i64::try_from(index).ok())
}

pub fn cell_box(metrics: &CellMetrics, row: i64, col: i64, end_col: i64) -> CellBox {
    CellBox {
        left: metrics.left + col as f64 * metrics.width,
        top: metrics.top + row as f64 * metrics.height,
        width: (end_col - col).max(0) as f64 * metrics.width,
        height: metrics.height,
    }
}

pub fn rows_to_make(visual_lines: i64, rows_below: i64, max_lines: i64) -> i64 {
    let wanted = visual_lines.max(1).min(max_lines);
    (wanted - 1 - rows_below).max(0)
}

pub fn scroll_up_sequence(rows: i64, cursor_row: i64, cursor_col: i64, n: i64) -> String {
    if n <= 0 {
        return String::new();
    }
    let target = (cursor_row - n).max(0);
    let newlines = "\n".repeat(usize::try_from(n).unwrap_or(0));
    format!(
        "\x1b[{rows};1H{newlines}\x1b[{};{}H",
        target + 1,
        cursor_col + 1
    )
}
