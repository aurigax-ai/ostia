use std::io;

use futures_util::stream::{self, Stream};
use tokio::io::{AsyncReadExt, Stdin};

const CHUNK_BYTES: usize = 64 * 1024;

pub fn stdin_chunks() -> impl Stream<Item = io::Result<Vec<u8>>> {
    stream::unfold(Some(tokio::io::stdin()), read_chunk)
}

async fn read_chunk(source: Option<Stdin>) -> Option<(io::Result<Vec<u8>>, Option<Stdin>)> {
    let mut stdin = source?;
    let mut buffer = vec![0; CHUNK_BYTES];
    match stdin.read(&mut buffer).await {
        Ok(0) => None,
        Ok(read) => {
            buffer.truncate(read);
            Some((Ok(buffer), Some(stdin)))
        }
        Err(error) => Some((Err(error), None)),
    }
}
