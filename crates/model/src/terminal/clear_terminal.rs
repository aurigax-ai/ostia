use std::future::Future;

pub const FORM_FEED: &str = "\x0c";

pub trait ClearTarget {
    fn rows(&self) -> usize;
    fn is_alternate_screen(&self) -> bool;
    fn cursor_y(&self) -> usize;
    fn write(&mut self, data: &str) -> impl Future<Output = ()>;
    fn scroll_to_bottom(&mut self);
    fn input(&mut self, data: &str, was_user_input: bool);
}

pub async fn clear_keeping_scrollback<T: ClearTarget>(term: &mut T, at_prompt: bool) -> bool {
    if term.is_alternate_screen() {
        return false;
    }
    let pushed = term.cursor_y() + 1;
    let data = format!("\x1b[{};1H{}\x1b[H", term.rows(), "\n".repeat(pushed));
    term.write(&data).await;
    term.scroll_to_bottom();
    if at_prompt {
        term.input(FORM_FEED, true);
    }
    true
}
