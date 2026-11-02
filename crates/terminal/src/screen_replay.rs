use ostia_base::js::{js_number, js_trim};

pub const SCREEN_INFO_FORMAT: &str = "#{alternate_on} #{cursor_x} #{cursor_y} #{cursor_flag} #{keypad_cursor_flag} #{keypad_flag} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_any_flag} #{mouse_sgr_flag} #{bracket_paste_flag}";

const RESET: &str = "\x1b[0m";

const MODES: [(usize, &str); 7] = [
    (4, "\x1b[?1h"),
    (5, "\x1b="),
    (6, "\x1b[?1000h"),
    (7, "\x1b[?1002h"),
    (8, "\x1b[?1003h"),
    (9, "\x1b[?1006h"),
    (10, "\x1b[?2004h"),
];

fn lines(rows: &[&str]) -> String {
    rows.iter()
        .map(|row| format!("{row}{RESET}"))
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn number_or_zero(field: Option<&str>) -> f64 {
    let number = field.map_or(f64::NAN, js_number);
    if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    }
}

pub fn screen_replay(info: &str, normal: &[&str], alternate: Option<&[&str]>) -> String {
    let fields: Vec<&str> = js_trim(info).split(' ').collect();
    let field = |index: usize| fields.get(index).copied();
    let x = number_or_zero(field(1));
    let y = number_or_zero(field(2));
    let mut out = lines(normal);
    if let Some(rows) = alternate {
        out.push_str(&format!("\x1b[?1049h\x1b[H\x1b[2J{}", lines(rows)));
    }
    out.push_str(&format!("\x1b[{};{}H", y + 1.0, x + 1.0));
    if field(3) == Some("0") {
        out.push_str("\x1b[?25l");
    }
    for (index, set) in MODES {
        if field(index) == Some("1") {
            out.push_str(set);
        }
    }
    out
}
