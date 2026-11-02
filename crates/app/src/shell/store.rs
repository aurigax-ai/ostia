use gpui_kit::{App, Context, Entity};

pub struct Store<S: 'static> {
    state: S,
}

impl<S: 'static> Store<S> {
    pub fn new(state: S) -> Self {
        Self { state }
    }

    pub fn state(&self) -> &S {
        &self.state
    }

    pub fn change(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut S) -> bool) -> bool {
        let changed = change(&mut self.state);
        if changed {
            cx.notify();
        }
        changed
    }
}

pub fn change_reading<R: 'static, W: 'static>(
    read: &Entity<Store<R>>,
    write: &Entity<Store<W>>,
    cx: &mut App,
    change: impl FnOnce(&R, &mut W) -> bool,
) -> bool {
    read.update(cx, |read, cx| {
        write.update(cx, |write, cx| {
            write.change(cx, |state| change(read.state(), state))
        })
    })
}

pub fn change_both<A: 'static, B: 'static>(
    first: &Entity<Store<A>>,
    second: &Entity<Store<B>>,
    cx: &mut App,
    change: impl FnOnce(&mut A, &mut B) -> bool,
) -> bool {
    first.update(cx, |first, cx| {
        let changed = second.update(cx, |second, cx| {
            let changed = change(&mut first.state, &mut second.state);
            if changed {
                cx.notify();
            }
            changed
        });
        if changed {
            cx.notify();
        }
        changed
    })
}
