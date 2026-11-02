#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::stream::{self, Stream, StreamExt};
use ostia_cli::common::stdin_text::{StdinTextError, StdinTooLarge, read_stdin_up_to};

fn chunks(parts: &[&[u8]]) -> impl Stream<Item = io::Result<Vec<u8>>> + use<> {
    stream::iter(
        parts
            .iter()
            .map(|part| Ok(part.to_vec()))
            .collect::<Vec<_>>(),
    )
}

fn is_too_large(error: &StdinTextError) -> bool {
    matches!(error, StdinTextError::TooLarge(_))
}

#[tokio::test]
async fn reads_the_text_joins_a_multibyte_character_split_between_chunks_and_drops_the_last_newline()
 {
    let bytes = "héllo\n".as_bytes();
    let text = read_stdin_up_to(100, chunks(&[&bytes[..2], &bytes[2..]]))
        .await
        .unwrap();
    assert_eq!(text, "héllo");
}

#[tokio::test]
async fn counts_the_size_the_text_has_once_it_is_json_escaped_which_is_what_the_message_carries() {
    let quotes = "\"".repeat(60);
    assert_eq!(
        read_stdin_up_to(120, chunks(&[quotes.as_bytes()]))
            .await
            .unwrap(),
        quotes
    );
    let error = read_stdin_up_to(119, chunks(&[quotes.as_bytes()]))
        .await
        .unwrap_err();
    assert!(is_too_large(&error));
    let controls = "\u{1}".repeat(20);
    let error = read_stdin_up_to(100, chunks(&[controls.as_bytes()]))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("stdin is over"));
    assert_eq!(
        read_stdin_up_to(120, chunks(&[controls.as_bytes()]))
            .await
            .unwrap(),
        controls
    );
}

#[tokio::test]
async fn stops_as_soon_as_the_escaped_size_is_over_across_chunks() {
    let read = AtomicUsize::new(0);
    let many = stream::iter(0..100).map(|_| {
        read.fetch_add(1, Ordering::SeqCst);
        Ok::<Vec<u8>, io::Error>(b"xxxxxxxxxx".to_vec())
    });
    let error = read_stdin_up_to(55, many).await.unwrap_err();
    assert!(is_too_large(&error));
    assert_eq!(read.load(Ordering::SeqCst), 6);
}

#[tokio::test]
async fn counts_each_character_by_the_bytes_json_gives_it() {
    let table: [(&str, usize); 13] = [
        ("a", 1),
        ("\"", 2),
        ("\\", 2),
        ("\n", 2),
        ("\r", 2),
        ("\t", 2),
        ("\u{8}", 2),
        ("\u{c}", 2),
        ("\u{1}", 6),
        ("\u{7f}", 1),
        ("é", 2),
        ("😀", 4),
        ("\u{2028}", 3),
    ];
    for (text, size) in table {
        assert!(
            read_stdin_up_to(size, chunks(&[text.as_bytes()]))
                .await
                .is_ok(),
            "{text:?} fits in {size}"
        );
        let error = read_stdin_up_to(size - 1, chunks(&[text.as_bytes()]))
            .await
            .unwrap_err();
        assert!(is_too_large(&error), "{text:?} is over {}", size - 1);
    }
}

#[tokio::test]
async fn names_the_limit_in_whole_mebibytes() {
    let limit = 5 * 1024 * 1024;
    let error = read_stdin_up_to(limit, chunks(&[&vec![b'"'; limit / 2 + 1]]))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "stdin is over 5 MiB");
    assert_eq!(StdinTooLarge::new(limit).to_string(), "stdin is over 5 MiB");
}

#[tokio::test]
async fn drops_only_one_trailing_newline_and_keeps_a_lone_carriage_return() {
    let table: [(&[u8], &str); 8] = [
        (b"a\n", "a"),
        (b"a\r\n", "a"),
        (b"a\n\n", "a\n"),
        (b"a\r\n\r\n", "a\r\n"),
        (b"a", "a"),
        (b"a\r", "a\r"),
        (b"\n", ""),
        (b"", ""),
    ];
    for (input, expected) in table {
        assert_eq!(
            read_stdin_up_to(100, chunks(&[input])).await.unwrap(),
            expected,
            "{input:?}"
        );
    }
}

#[tokio::test]
async fn drops_a_newline_that_arrives_in_its_own_chunk() {
    assert_eq!(
        read_stdin_up_to(100, chunks(&[b"a\r", b"\n"]))
            .await
            .unwrap(),
        "a"
    );
}

#[tokio::test]
async fn replaces_bytes_that_are_not_utf8_as_a_text_decoder_does() {
    assert_eq!(
        read_stdin_up_to(100, chunks(&[b"a\xffb"])).await.unwrap(),
        "a\u{fffd}b"
    );
    assert_eq!(
        read_stdin_up_to(100, chunks(&[b"a\xc3"])).await.unwrap(),
        "a\u{fffd}"
    );
}

#[tokio::test]
async fn counts_the_replacement_a_cut_off_character_leaves_at_the_end() {
    let error = read_stdin_up_to(2, chunks(&[b"\xc3"])).await.unwrap_err();
    assert!(is_too_large(&error));
    assert_eq!(
        read_stdin_up_to(3, chunks(&[b"\xc3"])).await.unwrap(),
        "\u{fffd}"
    );
}

#[tokio::test]
async fn passes_a_stream_failure_on_as_an_io_error() {
    let failing = stream::iter(vec![
        Ok(b"ab".to_vec()),
        Err(io::Error::other("pipe broke")),
    ]);
    match read_stdin_up_to(100, failing).await.unwrap_err() {
        StdinTextError::Io(error) => assert_eq!(error.to_string(), "pipe broke"),
        other => panic!("{other}"),
    }
}
