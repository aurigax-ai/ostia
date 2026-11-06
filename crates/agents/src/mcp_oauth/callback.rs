use std::convert::Infallible;
use std::fmt;
use std::future::poll_fn;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, header};
use hyper_util::rt::TokioIo;
use ostia_base::same_bytes::same_bytes;
use ostia_contract::PRODUCT_DISPLAY_NAME;
use ostia_contract::chat_tools::McpSignInError;
use parking_lot::Mutex;
use reqwest::Url;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::page::{clip, escape_html};

const CALLBACK_PATH: &str = "/callback";
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignInFailure {
    pub code: McpSignInError,
    pub detail: Option<String>,
}

impl SignInFailure {
    pub fn new(code: McpSignInError) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: McpSignInError, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SignInPages {
    pub done: String,
    pub failed: String,
}

#[derive(Clone, Debug)]
pub struct CallbackOptions {
    pub state: String,
    pub timeout: Duration,
    pub pages: SignInPages,
    pub redirect_name: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CallbackResult {
    pub code: String,
    pub issuer: Option<String>,
}

impl fmt::Debug for CallbackResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallbackResult")
            .field("code", &"[hidden]")
            .field("issuer", &self.issuer)
            .finish()
    }
}

type Outcome = Result<CallbackResult, SignInFailure>;

struct Inner {
    state: String,
    hosts: [String; 2],
    pages: SignInPages,
    outcome: watch::Sender<Option<Outcome>>,
    listener: Mutex<Option<TcpListener>>,
    stop: CancellationToken,
}

impl Inner {
    fn settle(&self, outcome: Outcome) -> bool {
        self.outcome.send_if_modified(|slot| {
            if slot.is_some() {
                return false;
            }
            *slot = Some(outcome);
            true
        })
    }

    fn poll_accept(&self, cx: &mut Context<'_>) -> Poll<io::Result<(TcpStream, SocketAddr)>> {
        match self.listener.lock().as_ref() {
            Some(listener) => listener.poll_accept(cx),
            None => Poll::Pending,
        }
    }
}

pub struct CallbackListener {
    pub redirect_url: String,
    inner: Arc<Inner>,
}

impl CallbackListener {
    pub async fn result(&self) -> Outcome {
        let mut outcome = self.inner.outcome.subscribe();
        match outcome.wait_for(Option::is_some).await {
            Ok(slot) => slot
                .clone()
                .unwrap_or_else(|| Err(SignInFailure::new(McpSignInError::Cancelled))),
            Err(_) => Err(SignInFailure::new(McpSignInError::Cancelled)),
        }
    }

    pub fn close(&self) {
        self.inner
            .settle(Err(SignInFailure::new(McpSignInError::Cancelled)));
        self.inner.stop.cancel();
        let listener = self.inner.listener.lock().take();
        drop(listener);
    }
}

pub async fn open_callback_listener(options: CallbackOptions) -> io::Result<CallbackListener> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let name = options.redirect_name.as_deref().unwrap_or("127.0.0.1");
    let (outcome, _) = watch::channel(None);
    let inner = Arc::new(Inner {
        state: options.state,
        hosts: [format!("127.0.0.1:{port}"), format!("{name}:{port}")],
        pages: options.pages,
        outcome,
        listener: Mutex::new(Some(listener)),
        stop: CancellationToken::new(),
    });
    tokio::spawn(accept_loop(Arc::clone(&inner), port));
    tokio::spawn(expire(Arc::clone(&inner), options.timeout));
    Ok(CallbackListener {
        redirect_url: format!("http://{name}:{port}{CALLBACK_PATH}"),
        inner,
    })
}

async fn expire(inner: Arc<Inner>, timeout: Duration) {
    tokio::select! {
        () = inner.stop.cancelled() => {}
        () = tokio::time::sleep(timeout) => {
            inner.settle(Err(SignInFailure::new(McpSignInError::Timeout)));
        }
    }
}

async fn accept_loop(inner: Arc<Inner>, port: u16) {
    loop {
        let accepted = tokio::select! {
            () = inner.stop.cancelled() => return,
            accepted = poll_fn(|cx| inner.poll_accept(cx)) => accepted,
        };
        match accepted {
            Ok((stream, _)) => {
                tokio::spawn(serve(Arc::clone(&inner), port, stream));
            }
            Err(_) => tokio::time::sleep(ACCEPT_BACKOFF).await,
        }
    }
}

async fn serve(inner: Arc<Inner>, port: u16, stream: TcpStream) {
    let stop = inner.stop.clone();
    let service = service_fn(move |request: Request<hyper::body::Incoming>| {
        let reply = answer(&inner, port, &request);
        async move { Ok::<_, Infallible>(reply) }
    });
    let connection = http1::Builder::new().serve_connection(TokioIo::new(stream), service);
    tokio::select! {
        () = stop.cancelled() => {}
        _ = connection => {}
    }
}

fn page(status: u16, text: &str) -> Response<Full<Bytes>> {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{}</title><p>{}</p>",
        escape_html(PRODUCT_DISPLAY_NAME),
        escape_html(text)
    );
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::NOT_FOUND))
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CONNECTION, "close")
        .body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| Response::new(Full::default()))
}

fn answer<B>(inner: &Inner, port: u16, request: &Request<B>) -> Response<Full<Bytes>> {
    let failed = |status| page(status, &inner.pages.failed);
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let target = request
        .uri()
        .path_and_query()
        .map_or("/", |target| target.as_str());
    let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}{target}")) else {
        return failed(404);
    };
    if request.method() != Method::GET
        || !inner.hosts.iter().any(|allowed| allowed == host)
        || url.path() != CALLBACK_PATH
    {
        return failed(404);
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let sent_state = param("state");
    if !sent_state
        .as_deref()
        .is_some_and(|sent| same_bytes(sent.as_bytes(), inner.state.as_bytes()))
    {
        return failed(400);
    }
    let error = param("error").filter(|error| !error.is_empty());
    let code = param("code").filter(|code| !code.is_empty());
    let Some(code) = code.filter(|_| error.is_none()) else {
        let reason = match error {
            Some(error) => {
                let description = param("error_description").filter(|text| !text.is_empty());
                [Some(error), description]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(": ")
            }
            None => "no authorization code".to_owned(),
        };
        inner.settle(Err(SignInFailure::with_detail(
            McpSignInError::Failed,
            clip(&reason),
        )));
        return failed(400);
    };
    let settled = inner.settle(Ok(CallbackResult {
        code,
        issuer: param("iss"),
    }));
    if settled {
        page(200, &inner.pages.done)
    } else {
        failed(404)
    }
}
