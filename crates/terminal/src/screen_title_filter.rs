const ESC: char = '\x1b';
const CAN: char = '\x18';
const SUB: char = '\x1a';
const DEL: char = '\x7f';

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Escape,
    Title,
    TitleEscape,
}

#[derive(Default)]
pub struct ScreenTitleFilter {
    state: State,
}

fn is_c0(ch: char) -> bool {
    ch < ' ' && ch != ESC && ch != CAN && ch != SUB
}

impl ScreenTitleFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, data: &str) -> String {
        if self.state == State::Ground && !data.contains(ESC) {
            return data.to_owned();
        }
        let mut out = String::with_capacity(data.len());
        for ch in data.chars() {
            match self.state {
                State::Ground => {
                    if ch == ESC {
                        self.state = State::Escape;
                    } else {
                        out.push(ch);
                    }
                }
                State::Escape | State::TitleEscape => match ch {
                    _ if ch >= DEL => {}
                    'k' => self.state = State::Title,
                    '\\' if self.state == State::TitleEscape => self.state = State::Ground,
                    ESC => {}
                    _ if is_c0(ch) => out.push(ch),
                    _ => {
                        out.push(ESC);
                        out.push(ch);
                        self.state = State::Ground;
                    }
                },
                State::Title => {
                    if ch == ESC {
                        self.state = State::TitleEscape;
                    } else if ch == CAN || ch == SUB {
                        self.state = State::Ground;
                    }
                }
            }
        }
        out
    }
}
