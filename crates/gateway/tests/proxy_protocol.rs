#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use ostia_gateway::proxy_protocol::read_proxy_header;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::time::Instant;

async fn peer_of(header: &str, trailing: &str) -> Option<(String, u16, Vec<u8>)> {
    let (mut client, server) = duplex(1024);
    client
        .write_all(format!("{header}{trailing}").as_bytes())
        .await
        .unwrap();
    let (peer, mut stream) = read_proxy_header(server).await?;
    let mut rest = vec![0u8; trailing.len()];
    stream.read_exact(&mut rest).await.unwrap();
    drop(client);
    Some((peer.ip.to_string(), peer.port, rest))
}

async fn peer_ip(line: &str) -> Option<(String, u16)> {
    let (client, server) = duplex(1024);
    let mut client: DuplexStream = client;
    client
        .write_all(format!("{line}\r\n").as_bytes())
        .await
        .unwrap();
    read_proxy_header(server)
        .await
        .map(|(peer, _)| (peer.ip.to_string(), peer.port))
}

#[tokio::test]
async fn rly_c44_reports_the_sender_address_and_its_source_port_then_passes_the_rest_on() {
    let result = peer_of("PROXY TCP4 203.0.113.9 127.0.0.1 40000 40000\r\n", "hello").await;
    assert_eq!(
        result,
        Some(("203.0.113.9".to_owned(), 40000, b"hello".to_vec()))
    );
}

#[tokio::test]
async fn rly_c45_reads_an_ipv6_sender() {
    let result = peer_of("PROXY TCP6 2001:db8::7 ::1 5000 5000\r\n", "x").await;
    assert_eq!(
        result.map(|(ip, port, _)| (ip, port)),
        Some(("2001:db8::7".to_owned(), 5000))
    );
}

#[tokio::test]
async fn rly_c46_closes_on_a_family_that_does_not_match_the_address() {
    let result = peer_of("PROXY TCP6 203.0.113.9 127.0.0.1 1 1\r\n", "x").await;
    assert!(result.is_none());
}

#[tokio::test]
async fn refuses_every_header_that_is_not_a_well_formed_proxy_v1_line() {
    let lines = [
        "PORXY TCP4 203.0.113.9 127.0.0.1 1 1",
        "proxy TCP4 203.0.113.9 127.0.0.1 1 1",
        "PROXY UNKNOWN",
        "PROXY tcp4 203.0.113.9 127.0.0.1 1 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 1 1 extra",
        "PROXY TCP4 203.0.113.9 127.0.0.1 1 1 ",
        "PROXY  TCP4 203.0.113.9 127.0.0.1 1 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 65536 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 1 65536",
        "PROXY TCP4 203.0.113.9 127.0.0.1 123456 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 abc 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 -1 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 +1 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 \u{663} 1",
        "PROXY TCP4 203.0.113.9 127.0.0.1 1.5 1",
        "PROXY TCP4 999.0.113.9 127.0.0.1 1 1",
        "PROXY TCP4 203.0.113.9 999.0.0.1 1 1",
        "PROXY TCP4 203.0.113.9 ::1 1 1",
        "PROXY TCP6 2001:db8::7 127.0.0.1 1 1",
        "PROXY TCP4 example.org 127.0.0.1 1 1",
        "PROXY TCP4 \u{e9}.0.0.1 127.0.0.1 1 1",
        "",
    ];
    for line in lines {
        assert_eq!(peer_ip(line).await, None, "{line:?}");
    }
}

#[tokio::test]
async fn accepts_the_forms_node_accepts() {
    let accepted = [
        (
            "PROXY TCP4 203.0.113.9 127.0.0.1 00080 65535",
            ("203.0.113.9", 80),
        ),
        ("PROXY TCP4 203.0.113.9 127.0.0.1 0 0", ("203.0.113.9", 0)),
        ("PROXY TCP6 ::ffff:1.2.3.4 ::1 7 7", ("::ffff:1.2.3.4", 7)),
        ("PROXY TCP6 fe80::1%eth0 ::1 7 7", ("fe80::1%eth0", 7)),
        ("PROXY TCP6 2001:DB8::A ::1 65535 1", ("2001:DB8::A", 65535)),
    ];
    for (line, (ip, port)) in accepted {
        assert_eq!(peer_ip(line).await, Some((ip.to_owned(), port)), "{line:?}");
    }
}

#[tokio::test]
async fn refuses_a_header_that_is_longer_than_107_bytes() {
    let long = format!("PROXY TCP4 203.0.113.9 127.0.0.1 1 1{}", " ".repeat(80));
    assert_eq!(peer_ip(&long).await, None);
    let (mut client, server) = duplex(1024);
    client.write_all("a".repeat(108).as_bytes()).await.unwrap();
    assert!(read_proxy_header(server).await.is_none());
}

#[tokio::test]
async fn reads_a_header_that_arrives_in_pieces_and_keeps_the_bytes_after_it() {
    let (mut client, server) = duplex(1024);
    let reader = tokio::spawn(async move { read_proxy_header(server).await });
    for piece in [
        "PROXY TCP4 203.0",
        ".113.9 127.0.0.1 ",
        "4000 4000\r",
        "\nfirst",
    ] {
        client.write_all(piece.as_bytes()).await.unwrap();
        tokio::task::yield_now().await;
    }
    let (peer, mut stream) = reader.await.unwrap().unwrap();
    assert_eq!(
        (peer.ip.to_string(), peer.port),
        ("203.0.113.9".to_owned(), 4000)
    );
    client.write_all(b"second").await.unwrap();
    let mut rest = vec![0u8; 11];
    stream.read_exact(&mut rest).await.unwrap();
    assert_eq!(rest, b"firstsecond");
}

#[tokio::test]
async fn passes_writes_to_the_sender_and_the_end_of_the_sender_to_the_reader() {
    let (mut client, server) = duplex(1024);
    client
        .write_all(b"PROXY TCP4 203.0.113.9 127.0.0.1 1 1\r\n")
        .await
        .unwrap();
    let (_, mut stream) = read_proxy_header(server).await.unwrap();
    stream.write_all(b"pong").await.unwrap();
    let mut back = [0u8; 4];
    client.read_exact(&mut back).await.unwrap();
    assert_eq!(&back, b"pong");
    client.shutdown().await.unwrap();
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty());
}

#[tokio::test(start_paused = true)]
async fn closes_a_socket_that_sends_no_header_within_ten_seconds() {
    let (mut client, server) = duplex(1024);
    let started = Instant::now();
    assert!(read_proxy_header(server).await.is_none());
    assert!(started.elapsed() >= Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(11));
    let mut sink = Vec::new();
    assert_eq!(client.read_to_end(&mut sink).await.unwrap(), 0);
}

#[tokio::test(start_paused = true)]
async fn does_not_extend_the_deadline_while_a_header_arrives_one_byte_at_a_time() {
    let (mut client, server) = duplex(1024);
    let writer = tokio::spawn(async move {
        for byte in "PROXY TCP4 203.0.113.9 127.0.0.1 1 1".bytes() {
            if client.write_all(&[byte]).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        client
    });
    let started = Instant::now();
    assert!(read_proxy_header(server).await.is_none());
    assert!(started.elapsed() >= Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(12));
    writer.abort();
}
