use ostia_base::js::utf16_len;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineRange {
    pub start_line_number: usize,
    pub start_column: usize,
    pub end_line_number: usize,
    pub end_column: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineEdit {
    pub range: LineRange,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChangedLines {
    pub start: usize,
    pub end: usize,
}

fn common_ends(a: &[&str], b: &[&str]) -> (usize, usize) {
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head
        && tail < b.len() - head
        && a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
    {
        tail += 1;
    }
    (head, tail)
}

fn end_column(lines: &[&str], line_number: usize) -> usize {
    line_number
        .checked_sub(1)
        .and_then(|index| lines.get(index))
        .map_or(0, |line| utf16_len(line))
        + 1
}

fn range(start_line: usize, start_column: usize, end_line: usize, end_column: usize) -> LineRange {
    LineRange {
        start_line_number: start_line,
        start_column,
        end_line_number: end_line,
        end_column,
    }
}

pub fn minimal_line_edit(current: &str, next: &str) -> Option<LineEdit> {
    if current == next {
        return None;
    }
    let a: Vec<&str> = current.split('\n').collect();
    let b: Vec<&str> = next.split('\n').collect();
    let (head, tail) = common_ends(&a, &b);
    let old_end = a.len() - tail;
    let new_lines = b.get(head..b.len() - tail).unwrap_or(&[]);
    if old_end > head && new_lines.is_empty() {
        if old_end < a.len() {
            return Some(LineEdit {
                range: range(head + 1, 1, old_end + 1, 1),
                text: String::new(),
            });
        }
        if head > 0 {
            return Some(LineEdit {
                range: range(head, end_column(&a, head), old_end, end_column(&a, old_end)),
                text: String::new(),
            });
        }
    }
    if old_end > head {
        return Some(LineEdit {
            range: range(head + 1, 1, old_end, end_column(&a, old_end)),
            text: new_lines.join("\n"),
        });
    }
    if head >= a.len() {
        let column = end_column(&a, a.len());
        return Some(LineEdit {
            range: range(a.len(), column, a.len(), column),
            text: format!("\n{}", new_lines.join("\n")),
        });
    }
    Some(LineEdit {
        range: range(head + 1, 1, head + 1, 1),
        text: format!("{}\n", new_lines.join("\n")),
    })
}

pub fn changed_lines(current: &str, next: &str) -> Option<ChangedLines> {
    if current == next {
        return None;
    }
    let a: Vec<&str> = current.split('\n').collect();
    let b: Vec<&str> = next.split('\n').collect();
    let (head, tail) = common_ends(&a, &b);
    let end = b.len() - tail;
    (end > head).then_some(ChangedLines {
        start: head + 1,
        end,
    })
}
