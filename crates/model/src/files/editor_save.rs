use std::future::Future;

pub async fn save_formatted<E, Format, FormatFuture, Write, WriteFuture>(
    format_on_save: bool,
    format: Format,
    write: Write,
) -> bool
where
    Format: FnOnce() -> FormatFuture,
    FormatFuture: Future<Output = Result<(), E>>,
    Write: FnOnce() -> WriteFuture,
    WriteFuture: Future<Output = bool>,
{
    if format_on_save {
        let _ = format().await;
    }
    write().await
}
