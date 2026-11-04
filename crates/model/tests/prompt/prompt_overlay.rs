use ostia_contract::prompt_settings::PromptStyle;
use ostia_model::prompt::prompt_overlay::{
    CellBox, CellMetrics, MIN_INPUT_COLS, PromptPlacement, PromptPlacementInput, cell_box,
    place_prompt, right_prompt_start, rows_to_make, scroll_up_sequence,
};

fn base() -> PromptPlacementInput {
    PromptPlacementInput {
        input_line: 110,
        input_col: 14,
        viewport_y: 100,
        rows: 24,
        cols: 80,
        right_prompt_col: None,
        style: PromptStyle::Shell,
        same_line: false,
    }
}

#[test]
fn starts_the_editor_at_the_shell_input_column_so_the_shells_own_prompt_stays_visible() {
    assert_eq!(
        place_prompt(&base()),
        Some(PromptPlacement {
            row: 10,
            col: 14,
            end_col: 80,
            chips_row: None,
            rows_below: 13,
        })
    );
}

#[test]
fn stops_before_a_right_prompt_when_there_is_room_and_covers_it_when_there_is_not() {
    let roomy = PromptPlacementInput {
        right_prompt_col: Some(60),
        ..base()
    };
    assert_eq!(place_prompt(&roomy).unwrap().end_col, 60);
    let cramped = PromptPlacementInput {
        right_prompt_col: Some(14 + MIN_INPUT_COLS - 1),
        ..base()
    };
    assert_eq!(place_prompt(&cramped).unwrap().end_col, 80);
}

#[test]
fn puts_the_ostia_prompt_chips_on_the_row_above_and_keeps_the_shell_separator_before_the_input() {
    let input = PromptPlacementInput {
        style: PromptStyle::Ostia,
        input_col: 2,
        ..base()
    };
    let placed = place_prompt(&input).unwrap();
    assert_eq!(placed.col, 2);
    assert_eq!(placed.end_col, 80);
    assert_eq!(placed.chips_row, Some(9));
}

#[test]
fn covers_the_whole_row_for_a_same_line_ostia_prompt_which_draws_its_own_separator() {
    let same_line = PromptPlacementInput {
        style: PromptStyle::Ostia,
        same_line: true,
        ..base()
    };
    let placed = place_prompt(&same_line).unwrap();
    assert_eq!(placed.col, 0);
    assert_eq!(placed.end_col, 80);
    assert_eq!(placed.chips_row, None);
    let top = PromptPlacementInput {
        style: PromptStyle::Ostia,
        input_line: 100,
        ..base()
    };
    assert_eq!(place_prompt(&top).unwrap().chips_row, None);
}

#[test]
fn returns_null_when_the_input_line_is_scrolled_out_of_view() {
    let below = PromptPlacementInput {
        viewport_y: 111,
        ..base()
    };
    assert_eq!(place_prompt(&below), None);
    let above = PromptPlacementInput {
        viewport_y: 80,
        ..base()
    };
    assert_eq!(place_prompt(&above), None);
    let no_rows = PromptPlacementInput { rows: 0, ..base() };
    assert_eq!(place_prompt(&no_rows), None);
}

#[test]
fn reports_the_free_rows_under_the_input_line() {
    let last = PromptPlacementInput {
        input_line: 123,
        ..base()
    };
    assert_eq!(place_prompt(&last).unwrap().rows_below, 0);
}

#[test]
fn clamps_the_input_column_into_the_grid_and_caps_a_right_prompt_at_the_width() {
    let far = PromptPlacementInput {
        input_col: 200,
        ..base()
    };
    assert_eq!(place_prompt(&far).unwrap().col, 79);
    let negative = PromptPlacementInput {
        input_col: -3,
        ..base()
    };
    assert_eq!(place_prompt(&negative).unwrap().col, 0);
    let no_cols = PromptPlacementInput { cols: 0, ..base() };
    assert_eq!(place_prompt(&no_cols), None);
    let exact = PromptPlacementInput {
        right_prompt_col: Some(14 + MIN_INPUT_COLS),
        ..base()
    };
    assert_eq!(place_prompt(&exact).unwrap().end_col, 14 + MIN_INPUT_COLS);
    let beyond = PromptPlacementInput {
        right_prompt_col: Some(100),
        ..base()
    };
    assert_eq!(place_prompt(&beyond).unwrap().end_col, 80);
}

#[test]
fn finds_the_first_drawn_cell_after_the_input_column() {
    let cells = ["~", " ", "❯", " ", "", "", " ", "m", "a", "i", "n"];
    assert_eq!(right_prompt_start(&cells, 4), Some(7));
    assert_eq!(right_prompt_start(&cells, 0), Some(0));
    assert_eq!(right_prompt_start(&["a", " ", ""], 1), None);
    assert_eq!(right_prompt_start(&cells, 99), None);
}

#[test]
fn maps_a_row_and_column_range_to_pixels_from_the_grid_origin() {
    let metrics = CellMetrics {
        width: 8.0,
        height: 17.0,
        left: 6.0,
        top: 4.0,
    };
    assert_eq!(
        cell_box(&metrics, 3, 2, 10),
        CellBox {
            left: 22.0,
            top: 55.0,
            width: 64.0,
            height: 17.0,
        }
    );
    assert_eq!(cell_box(&metrics, 0, 10, 4).width, 0.0);
}

#[test]
fn asks_for_rows_only_when_the_draft_is_taller_than_the_space_under_the_prompt() {
    assert_eq!(rows_to_make(1, 0, 8), 0);
    assert_eq!(rows_to_make(3, 0, 8), 2);
    assert_eq!(rows_to_make(3, 5, 8), 0);
    assert_eq!(rows_to_make(20, 0, 8), 7);
    assert_eq!(rows_to_make(0, 0, 8), 0);
}

#[test]
fn scrolls_from_the_bottom_row_and_puts_the_cursor_back_on_the_moved_prompt() {
    assert_eq!(
        scroll_up_sequence(24, 23, 14, 2),
        "\x1b[24;1H\n\n\x1b[22;15H"
    );
    assert_eq!(scroll_up_sequence(24, 23, 14, 0), "");
    assert_eq!(scroll_up_sequence(24, 23, 14, -1), "");
    assert_eq!(
        scroll_up_sequence(24, 1, 0, 5),
        "\x1b[24;1H\n\n\n\n\n\x1b[1;1H"
    );
}
