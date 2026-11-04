use std::future::Future;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::pin::Pin;
use std::str::FromStr;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};

const PROXY_HEADER_MAX_BYTES: usize = 107;
const HEADER_DEADLINE: Duration = Duration::from_secs(10);
const READ_CHUNK_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyPeer {
    pub ip: String,
    pub port: u16,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IpVersion {
    V4,
    V6,
}

fn ip_version(text: &str) -> Option<IpVersion> {
    if Ipv4Addr::from_str(text).is_ok() {
        return Some(IpVersion::V4);
    }
    let (address, zone) = match text.split_once('%') {
        Some((address, zone)) => (address, Some(zone)),
        None => (text, None),
    };
    let zone_ok = zone.is_none_or(|zone| {
        !zone.is_empty()
            && zone
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b':'))
    });
    (zone_ok && Ipv6Addr::from_str(address).is_ok()).then_some(IpVersion::V6)
}

fn is_port(value: &str) -> Option<u16> {
    if value.is_empty() || value.len() > 5 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u16>().ok()
}

fn parse_proxy_line(line: &str) -> Option<ProxyPeer> {
    let parts: Vec<&str> = line.split(' ').collect();
    if parts.first() != Some(&"PROXY") || parts.len() > 6 {
        return None;
    }
    let part = |index: usize| parts.get(index).copied().unwrap_or("");
    let version = match part(1) {
        "TCP4" => IpVersion::V4,
        "TCP6" => IpVersion::V6,
        _ => return None,
    };
    let (src, dst) = (part(2), part(3));
    if src.is_empty() || dst.is_empty() || part(4).is_empty() || part(5).is_empty() {
        return None;
    }
    if ip_version(src) != Some(version) || ip_version(dst) != Some(version) {
        return None;
    }
    let port = is_port(part(4))?;
    is_port(part(5))?;
    Some(ProxyPeer {
        ip: src.to_owned(),
        port,
    })
}

fn find_crlf(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|pair| pair == b"\r\n")
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

async fn read_header<S: AsyncRead + Unpin>(stream: &mut S) -> Option<(ProxyPeer, Vec<u8>)> {
    let mut buffered: Vec<u8> = Vec::new();
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffered.extend_from_slice(&chunk[..read]);
        let Some(end) = find_crlf(&buffered) else {
            if buffered.len() > PROXY_HEADER_MAX_BYTES {
                return None;
            }
            continue;
        };
        if end + 2 > PROXY_HEADER_MAX_BYTES {
            return None;
        }
        let peer = parse_proxy_line(&latin1(&buffered[..end]))?;
        return Some((peer, buffered.split_off(end + 2)));
    }
}

pub struct ProxiedStream<S> {
    head: Vec<u8>,
    offset: usize,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for ProxiedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = &mut *self;
        if this.offset < this.head.len() {
            let take = (this.head.len() - this.offset).min(buf.remaining());
            buf.put_slice(&this.head[this.offset..this.offset + take]);
            this.offset += take;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for ProxiedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

pub fn read_proxy_header<S>(
    mut stream: S,
) -> impl Future<Output = Option<(ProxyPeer, ProxiedStream<S>)>> + Send
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let deadline = tokio::time::sleep(HEADER_DEADLINE);
    async move {
        tokio::pin!(deadline);
        let found = tokio::select! {
            found = read_header(&mut stream) => found,
            () = &mut deadline => None,
        };
        let (peer, head) = found?;
        Some((
            peer,
            ProxiedStream {
                head,
                offset: 0,
                inner: stream,
            },
        ))
    }
}
