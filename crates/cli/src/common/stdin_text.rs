use std::io::{self, IsTerminal};

use futures_util::pin_mut;
use futures_util::stream::{Stream, StreamExt};
use rustix::termios::{OptionalActions, Termios, tcgetattr, tcsetattr};
use tokio::io::{AsyncReadExt, stdin};
use tokio::signal::ctrl_c;

use super::mebibytes::rounded_mebibytes;
use super::utf8_decoder::Utf8Decoder;

#[derive(Debug, thiserror::Error)]
#[error("stdin is over {mebibytes} MiB")]
pub struct StdinTooLarge {
    mebibytes: usize,
}

impl StdinTooLarge {
    pub fn new(max: usize) -> Self {
        Self {
            mebibytes: rounded_mebibytes(max),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StdinTextError {
    #[error(transparent)]
    TooLarge(#[from] StdinTooLarge),
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn without_final_newline(mut text: String) -> String {
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    text
}

fn escaped_len(piece: &str) -> usize {
    piece
        .chars()
        .map(|ch| match ch {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            ch if ch < ' ' => 6,
            ch => ch.len_utf8(),
        })
        .sum()
}

struct Collected {
    text: String,
    escaped: usize,
    max: usize,
}

impl Collected {
    fn take(&mut self, piece: &str) -> Result<(), StdinTooLarge> {
        self.escaped += escaped_len(piece);
        if self.escaped > self.max {
            return Err(StdinTooLarge::new(self.max));
        }
        self.text.push_str(piece);
        Ok(())
    }
}

pub async fn read_all_stdin() -> io::Result<String> {
    let mut bytes = Vec::new();
    stdin().read_to_end(&mut bytes).await?;
    Ok(without_final_newline(
        Utf8Decoder::default().decode(&bytes, true),
    ))
}

pub async fn read_stdin_up_to<S>(max: usize, input: S) -> Result<String, StdinTextError>
where
    S: Stream<Item = io::Result<Vec<u8>>>,
{
    pin_mut!(input);
    let mut decoder = Utf8Decoder::default();
    let mut collected = Collected {
        text: String::new(),
        escaped: 0,
        max,
    };
    while let Some(chunk) = input.next().await {
        collected.take(&decoder.decode(&chunk?, false))?;
    }
    collected.take(&decoder.decode(&[], true))?;
    Ok(without_final_newline(collected.text))
}

pub async fn read_secret_from_stdin(prompt_label: &str) -> io::Result<String> {
    if io::stdin().is_terminal() {
        eprint!("{prompt_label} (input hidden): ");
        return read_line_no_echo().await;
    }
    read_all_stdin().await
}

struct RawMode {
    original: Termios,
}

impl RawMode {
    fn enable() -> io::Result<Self> {
        let original = tcgetattr(io::stdin())?;
        let mut raw = original.clone();
        raw.make_raw();
        tcsetattr(io::stdin(), OptionalActions::Now, &raw)?;
        Ok(Self { original })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = tcsetattr(io::stdin(), OptionalActions::Now, &self.original);
    }
}

fn aborted() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "aborted")
}

async fn read_masked_line() -> io::Result<String> {
    let mut source = stdin();
    let mut decoder = Utf8Decoder::default();
    let mut input = String::new();
    let mut buffer = [0; 1024];
    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "stdin closed before a value was entered",
            ));
        }
        for ch in decoder.decode(&buffer[..read], false).chars() {
            match ch {
                '\r' | '\n' | '\u{4}' => return Ok(input),
                '\u{3}' => return Err(aborted()),
                '\u{7f}' | '\u{8}' => {
                    input.pop();
                }
                ch => input.push(ch),
            }
        }
    }
}

const INTERRUPTED_EXIT_CODE: i32 = 130;

fn exit_on_interrupt() {
    tokio::spawn(async {
        if ctrl_c().await.is_ok() {
            std::process::exit(INTERRUPTED_EXIT_CODE);
        }
    });
}

async fn read_line_no_echo() -> io::Result<String> {
    let raw = RawMode::enable()?;
    let outcome = tokio::select! {
        line = read_masked_line() => Some(line),
        _ = ctrl_c() => None,
    };
    drop(raw);
    exit_on_interrupt();
    let finished = match &outcome {
        Some(Ok(_)) | None => true,
        Some(Err(error)) => error.kind() == io::ErrorKind::Interrupted,
    };
    if finished {
        eprintln!();
    }
    match outcome {
        Some(line) => line,
        None => std::process::exit(INTERRUPTED_EXIT_CODE),
    }
}
