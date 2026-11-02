#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use ostia_browser::signin_user_agent::{
    AgentGuest, AgentHost, AgentSession, BeforeSendDetails, BeforeSendHeaders, BrowserAgents,
    CommandFuture, DeviceAgent, ELECTRON_AGENT_HOSTS, NavigationDetails, SigninAgents,
    UserAgentMetadata, browser_agents, electron_agent_metadata, wants_electron_agent,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;

const ELECTRON: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ostia/0.5.10 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
const REWRITTEN: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36";
const SIGNIN: &str = "https://accounts.google.com/signin";

fn host() -> AgentHost {
    AgentHost {
        chrome_version: "152.0.7977.130".to_owned(),
        platform: "darwin".to_owned(),
        system_version: "26.1".to_owned(),
        arch: "arm64".to_owned(),
    }
}

fn agents() -> BrowserAgents {
    browser_agents(ELECTRON, "ostia", &host())
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct FakeSession {
    id: u32,
    agent: Mutex<String>,
    set_calls: Mutex<Vec<String>>,
    listeners: Mutex<Vec<BeforeSendHeaders>>,
}

impl AgentSession for FakeSession {
    fn id(&self) -> u32 {
        self.id
    }

    fn user_agent(&self) -> String {
        self.agent.lock().unwrap().clone()
    }

    fn set_user_agent(&self, user_agent: &str) {
        self.set_calls.lock().unwrap().push(user_agent.to_owned());
        *self.agent.lock().unwrap() = user_agent.to_owned();
    }

    fn on_before_send_headers(&self, listener: BeforeSendHeaders) {
        self.listeners.lock().unwrap().push(listener);
    }
}

fn fake_session() -> Arc<FakeSession> {
    Arc::new(FakeSession {
        id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
        agent: Mutex::new(ELECTRON.to_owned()),
        set_calls: Mutex::new(Vec::new()),
        listeners: Mutex::new(Vec::new()),
    })
}

fn user_agent_of(headers: &[(String, String)]) -> String {
    headers
        .iter()
        .find(|(name, _)| name == "User-Agent")
        .map(|(_, value)| value.clone())
        .unwrap()
}

fn send_to(session: &FakeSession, url: &str, web_contents_id: Option<u32>) -> String {
    let listener = session.listeners.lock().unwrap()[0].clone();
    let headers = listener(&BeforeSendDetails {
        url: url.to_owned(),
        web_contents_id,
        request_headers: vec![
            ("Accept".to_owned(), "*/*".to_owned()),
            ("User-Agent".to_owned(), ELECTRON.to_owned()),
        ],
    });
    user_agent_of(&headers)
}

#[derive(Clone, Copy)]
enum Answer {
    Never,
    Reject,
    Ack,
}

struct FakeGuest {
    id: u32,
    attached: AtomicBool,
    answer: Mutex<Answer>,
    calls: Mutex<Vec<(String, Value)>>,
    pending: Mutex<Vec<oneshot::Sender<()>>>,
}

impl AgentGuest for FakeGuest {
    fn id(&self) -> u32 {
        self.id
    }

    fn debugger_attached(&self) -> bool {
        self.attached.load(Ordering::SeqCst)
    }

    fn send_command(&self, method: &str, params: Value) -> CommandFuture {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        match *self.answer.lock().unwrap() {
            Answer::Never => Box::pin(std::future::pending()),
            Answer::Reject => Box::pin(async { Err("detached".to_owned()) }),
            Answer::Ack => {
                let (sender, receiver) = oneshot::channel();
                self.pending.lock().unwrap().push(sender);
                Box::pin(async move {
                    let _ = receiver.await;
                    Ok(json!({}))
                })
            }
        }
    }
}

impl FakeGuest {
    fn overrides(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "Emulation.setUserAgentOverride")
            .map(|(_, params)| params["userAgent"].as_str().unwrap().to_owned())
            .collect()
    }

    fn ack(&self) {
        let sender = self.pending.lock().unwrap().pop().unwrap();
        let _ = sender.send(());
    }
}

fn fake_guest(answer: Answer) -> Arc<FakeGuest> {
    Arc::new(FakeGuest {
        id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
        attached: AtomicBool::new(true),
        answer: Mutex::new(answer),
        calls: Mutex::new(Vec::new()),
        pending: Mutex::new(Vec::new()),
    })
}

fn start(service: &SigninAgents, guest: &FakeGuest, url: &str) {
    service.did_start_navigation(
        guest.id,
        &NavigationDetails {
            url: url.to_owned(),
            is_main_frame: true,
            is_same_document: false,
        },
    );
}

fn redirect(service: &SigninAgents, guest: &FakeGuest, url: &str) {
    service.did_redirect_navigation(
        guest.id,
        &NavigationDetails {
            url: url.to_owned(),
            is_main_frame: true,
            is_same_document: false,
        },
    );
}

fn follow(service: &SigninAgents, guest: &Arc<FakeGuest>, start_url: Option<&str>) {
    service.follow_agent_by_host(guest.clone(), &agents(), start_url);
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn matches_the_google_sign_in_hosts_on_any_port_and_in_any_case() {
    assert_eq!(
        ELECTRON_AGENT_HOSTS,
        ["accounts.google.com", "accounts.youtube.com"]
    );
    for url in [
        "https://accounts.google.com/v3/signin/identifier?flow=1",
        "https://accounts.youtube.com/accounts/CheckConnection",
        "http://ACCOUNTS.Google.com/",
        "https://accounts.google.com:8443/",
    ] {
        assert!(wants_electron_agent(url), "{url}");
    }
}

#[test]
fn takes_exact_hosts_only_so_subdomains_parents_and_look_alikes_keep_the_rewritten_agent() {
    for url in [
        "https://docs.google.com/",
        "https://mail.google.com/mail/u/0/",
        "https://myaccount.google.com/",
        "https://google.com/",
        "https://www.youtube.com/",
        "https://foo.accounts.google.com/",
        "https://accounts.google.com./",
        "https://accounts.google.com.tw/",
        "https://accounts.google.co.jp/",
        "https://accounts.google.com.evil.example/",
        "https://evil.example/accounts.google.com",
        "https://evil.example/?next=https://accounts.google.com/",
        "https://web.whatsapp.com/",
        "https://teams.microsoft.com/",
    ] {
        assert!(!wants_electron_agent(url), "{url}");
    }
}

#[test]
fn goes_by_host_alone_so_sockets_to_a_sign_in_host_match_and_urls_without_one_do_not() {
    assert!(wants_electron_agent("wss://accounts.google.com/socket"));
    for url in [
        "blob:https://accounts.google.com/0b1c",
        "file:///accounts.google.com",
        "about:blank",
        "data:text/html,accounts.google.com",
        "accounts.google.com",
        "",
    ] {
        assert!(!wants_electron_agent(url), "{url}");
    }
}

#[test]
fn keeps_the_rewritten_agent_as_the_default_and_the_electron_agent_untouched() {
    let agents = agents();
    assert_eq!(agents.rewritten, REWRITTEN);
    assert_eq!(agents.electron, ELECTRON);
}

#[test]
fn describes_electron_as_plain_chromium_without_a_google_chrome_brand() {
    assert_eq!(
        serde_json::to_value(electron_agent_metadata(&host())).unwrap(),
        json!({
            "brands": [
                {"brand": "Not?A_Brand", "version": "24"},
                {"brand": "Chromium", "version": "152"},
            ],
            "fullVersionList": [
                {"brand": "Not?A_Brand", "version": "24.0.0.0"},
                {"brand": "Chromium", "version": "152.0.7977.130"},
            ],
            "fullVersion": "152.0.7977.130",
            "platform": "macOS",
            "platformVersion": "26.1.0",
            "architecture": "arm",
            "model": "",
            "mobile": false,
            "bitness": "64",
            "wow64": false,
        })
    );
    let linux = electron_agent_metadata(&AgentHost {
        platform: "linux".to_owned(),
        system_version: "6.17.2-arch1-1".to_owned(),
        arch: "x64".to_owned(),
        ..host()
    });
    assert_eq!(linux.platform, "Linux");
    assert_eq!(linux.platform_version, "6.17.2");
    assert_eq!(linux.architecture, "x86");
}

#[test]
fn sets_the_rewritten_agent_on_the_session_and_the_electron_agent_only_on_sign_in_requests() {
    let session = fake_session();
    let service = SigninAgents::new();
    assert_eq!(
        service.use_browser_agents(session.clone(), "ostia", &host()),
        agents()
    );
    assert_eq!(
        session.set_calls.lock().unwrap().as_slice(),
        &[REWRITTEN.to_owned()]
    );
    assert_eq!(
        send_to(&session, "https://docs.google.com/", None),
        REWRITTEN
    );
    assert_eq!(
        send_to(&session, "https://accounts.google.com/ServiceLogin", None),
        ELECTRON
    );
    assert_eq!(
        send_to(
            &session,
            "https://accounts.youtube.com/accounts/CheckConnection",
            None
        ),
        ELECTRON
    );
    assert_eq!(
        send_to(&session, "https://ssl.gstatic.com/logo.png", None),
        REWRITTEN
    );
}

#[test]
fn sets_the_rewritten_agent_on_the_first_request_after_leaving_the_sign_in_hosts() {
    let session = fake_session();
    SigninAgents::new().use_browser_agents(session.clone(), "ostia", &host());
    assert_eq!(
        send_to(&session, "https://accounts.google.com/", None),
        ELECTRON
    );
    assert_eq!(
        send_to(&session, "https://web.whatsapp.com/", None),
        REWRITTEN
    );
    assert_eq!(
        send_to(&session, "https://docs.google.com/document/d/x", None),
        REWRITTEN
    );
}

#[test]
fn replaces_the_agent_header_whatever_its_case_and_keeps_the_other_headers() {
    let session = fake_session();
    SigninAgents::new().use_browser_agents(session.clone(), "ostia", &host());
    let listener = session.listeners.lock().unwrap()[0].clone();
    let sent = listener(&BeforeSendDetails {
        url: "https://web.whatsapp.com/".to_owned(),
        web_contents_id: None,
        request_headers: vec![
            ("user-agent".to_owned(), ELECTRON.to_owned()),
            ("Cookie".to_owned(), "a=1".to_owned()),
        ],
    });
    assert_eq!(
        sent,
        vec![
            ("Cookie".to_owned(), "a=1".to_owned()),
            ("User-Agent".to_owned(), REWRITTEN.to_owned()),
        ]
    );
}

#[test]
fn reads_the_electron_agent_once_per_session_before_rewriting_it_however_many_guests_share_it() {
    let session = fake_session();
    let service = SigninAgents::new();
    service.use_browser_agents(session.clone(), "ostia", &host());
    assert_eq!(
        service.use_browser_agents(session.clone(), "ostia", &host()),
        agents()
    );
    assert_eq!(session.listeners.lock().unwrap().len(), 1);
    assert_eq!(session.set_calls.lock().unwrap().len(), 1);
    assert_eq!(
        send_to(&session, "https://accounts.google.com/", None),
        ELECTRON
    );
}

#[tokio::test]
async fn overrides_the_page_agent_when_a_main_frame_navigation_enters_or_leaves_the_sign_in_hosts()
{
    let service = SigninAgents::new();
    let guest = fake_guest(Answer::Never);
    follow(&service, &guest, None);
    assert_eq!(guest.overrides(), strings(&[REWRITTEN]));
    start(&service, &guest, "https://example.com/");
    start(&service, &guest, "https://docs.google.com/");
    assert_eq!(guest.overrides(), strings(&[REWRITTEN]));
    redirect(&service, &guest, "https://accounts.google.com/ServiceLogin");
    assert_eq!(guest.overrides(), strings(&[REWRITTEN, ELECTRON]));
    start(&service, &guest, "https://accounts.google.com/v3/signin");
    start(&service, &guest, "https://web.whatsapp.com/");
    assert_eq!(
        guest.overrides(),
        strings(&[REWRITTEN, ELECTRON, REWRITTEN])
    );
    assert!(guest.calls.lock().unwrap().contains(&(
        "Emulation.setUserAgentOverride".to_owned(),
        json!({
            "userAgent": ELECTRON,
            "userAgentMetadata": serde_json::to_value(&agents().metadata).unwrap(),
        })
    )));
}

#[tokio::test]
async fn starts_from_the_agent_of_the_address_a_popup_opens_at() {
    let service = SigninAgents::new();
    let guest = fake_guest(Answer::Never);
    follow(
        &service,
        &guest,
        Some("https://accounts.google.com/o/oauth2/auth"),
    );
    assert_eq!(guest.overrides(), strings(&[ELECTRON]));
    start(&service, &guest, "https://accounts.google.com/v3/signin");
    start(&service, &guest, "https://example.com/callback");
    assert_eq!(guest.overrides(), strings(&[ELECTRON, REWRITTEN]));
}

#[tokio::test]
async fn leaves_subframes_and_same_document_navigations_alone() {
    let service = SigninAgents::new();
    let guest = fake_guest(Answer::Never);
    follow(&service, &guest, None);
    service.did_start_navigation(
        guest.id,
        &NavigationDetails {
            url: "https://accounts.youtube.com/".to_owned(),
            is_main_frame: false,
            is_same_document: false,
        },
    );
    service.did_redirect_navigation(
        guest.id,
        &NavigationDetails {
            url: "https://accounts.google.com/".to_owned(),
            is_main_frame: false,
            is_same_document: false,
        },
    );
    service.did_start_navigation(
        guest.id,
        &NavigationDetails {
            url: "https://accounts.google.com/#x".to_owned(),
            is_main_frame: true,
            is_same_document: true,
        },
    );
    assert_eq!(guest.overrides(), strings(&[REWRITTEN]));
}

#[tokio::test]
async fn does_not_wait_for_the_override_which_only_answers_once_the_navigation_proceeds() {
    let service = SigninAgents::new();
    let guest = fake_guest(Answer::Never);
    follow(&service, &guest, None);
    start(&service, &guest, "https://accounts.google.com/");
    start(&service, &guest, "https://docs.google.com/");
    start(&service, &guest, "https://accounts.google.com/");
    assert_eq!(
        guest.overrides(),
        strings(&[REWRITTEN, ELECTRON, REWRITTEN, ELECTRON])
    );
}

#[tokio::test]
async fn swallows_a_failed_override() {
    let service = SigninAgents::new();
    let guest = fake_guest(Answer::Reject);
    follow(&service, &guest, None);
    start(&service, &guest, "https://accounts.google.com/");
    tokio::task::yield_now().await;
    assert_eq!(guest.overrides(), strings(&[REWRITTEN, ELECTRON]));
}

#[tokio::test]
async fn follows_each_guest_once_and_skips_a_guest_without_a_debugger() {
    let service = SigninAgents::new();
    let guest = fake_guest(Answer::Never);
    follow(&service, &guest, None);
    follow(&service, &guest, None);
    start(&service, &guest, "https://accounts.google.com/");
    assert_eq!(guest.overrides(), strings(&[REWRITTEN, ELECTRON]));

    let detached = fake_guest(Answer::Never);
    detached.attached.store(false, Ordering::SeqCst);
    follow(&service, &detached, None);
    start(&service, &detached, "https://accounts.google.com/");
    assert!(detached.calls.lock().unwrap().is_empty());
}

fn slow_guest(service: &SigninAgents) -> Arc<FakeGuest> {
    let guest = fake_guest(Answer::Ack);
    follow(service, &guest, None);
    start(service, &guest, "https://example.com/");
    guest
}

#[tokio::test]
async fn hands_back_the_agent_switch_of_a_redirect_into_a_sign_in_host_until_it_is_acknowledged() {
    let service = SigninAgents::new();
    let guest = slow_guest(&service);
    redirect(&service, &guest, SIGNIN);
    let restart = service
        .restart_after_agent(guest.id, SIGNIN, "GET")
        .unwrap();
    let released = Arc::new(AtomicBool::new(false));
    let waiter = tokio::spawn({
        let released = released.clone();
        async move {
            restart.wait().await;
            released.store(true, Ordering::SeqCst);
        }
    });
    tokio::task::yield_now().await;
    assert!(!released.load(Ordering::SeqCst));
    guest.ack();
    waiter.await.unwrap();
    assert!(released.load(Ordering::SeqCst));
    assert!(
        service
            .restart_after_agent(guest.id, SIGNIN, "GET")
            .is_none()
    );
}

#[tokio::test]
async fn hands_it_back_once_per_redirect() {
    let service = SigninAgents::new();
    let guest = slow_guest(&service);
    redirect(&service, &guest, SIGNIN);
    assert!(
        service
            .restart_after_agent(guest.id, SIGNIN, "GET")
            .is_some()
    );
    assert!(
        service
            .restart_after_agent(guest.id, SIGNIN, "GET")
            .is_none()
    );
}

#[tokio::test]
async fn leaves_post_requests_and_other_addresses_alone() {
    let service = SigninAgents::new();
    let guest = slow_guest(&service);
    redirect(&service, &guest, SIGNIN);
    assert!(
        service
            .restart_after_agent(guest.id, SIGNIN, "POST")
            .is_none()
    );
    assert!(
        service
            .restart_after_agent(guest.id, "https://example.com/other", "GET")
            .is_none()
    );
    assert!(
        service
            .restart_after_agent(guest.id, SIGNIN, "GET")
            .is_some()
    );
}

#[tokio::test]
async fn leaves_a_redirect_that_keeps_the_agent_alone() {
    let service = SigninAgents::new();
    let guest = slow_guest(&service);
    redirect(&service, &guest, "https://docs.google.com/");
    assert!(
        service
            .restart_after_agent(guest.id, "https://docs.google.com/", "GET")
            .is_none()
    );
}

#[tokio::test]
async fn does_not_restart_a_plain_navigation_into_a_sign_in_host() {
    let service = SigninAgents::new();
    let guest = slow_guest(&service);
    start(&service, &guest, SIGNIN);
    assert!(
        service
            .restart_after_agent(guest.id, SIGNIN, "GET")
            .is_none()
    );
}

const IPHONE: &str =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile/15E148 Safari/604.1";

fn device() -> DeviceAgent {
    DeviceAgent {
        user_agent: IPHONE.to_owned(),
        metadata: UserAgentMetadata {
            mobile: true,
            ..agents().metadata
        },
    }
}

#[tokio::test]
async fn sends_the_device_agent_from_that_guest_only_sign_in_hosts_included_until_cleared() {
    let session = fake_session();
    let service = SigninAgents::new();
    service.use_browser_agents(session.clone(), "ostia", &host());
    let guest = fake_guest(Answer::Never);
    follow(&service, &guest, None);
    service.set_device_agent(guest.id, Some(device()));
    assert_eq!(
        send_to(&session, "https://example.com/", Some(guest.id)),
        IPHONE
    );
    assert_eq!(
        send_to(&session, "https://accounts.google.com/", Some(guest.id)),
        IPHONE
    );
    assert_eq!(
        send_to(&session, "https://example.com/", Some(guest.id + 1000)),
        REWRITTEN
    );
    assert_eq!(send_to(&session, "https://example.com/", None), REWRITTEN);
    service.set_device_agent(guest.id, None);
    assert_eq!(
        send_to(&session, "https://example.com/", Some(guest.id)),
        REWRITTEN
    );
}

#[tokio::test]
async fn overrides_the_page_agent_with_the_device_and_its_metadata_and_navigation_keeps_it() {
    let service = SigninAgents::new();
    let guest = fake_guest(Answer::Never);
    follow(&service, &guest, None);
    service.set_device_agent(guest.id, Some(device()));
    assert_eq!(
        guest.calls.lock().unwrap().last().unwrap(),
        &(
            "Emulation.setUserAgentOverride".to_owned(),
            json!({
                "userAgent": IPHONE,
                "userAgentMetadata": serde_json::to_value(&device().metadata).unwrap(),
            })
        )
    );
    start(&service, &guest, "https://accounts.google.com/");
    assert_eq!(guest.overrides(), strings(&[REWRITTEN, IPHONE]));
    service.set_device_agent(guest.id, None);
    assert_eq!(guest.overrides(), strings(&[REWRITTEN, IPHONE, ELECTRON]));
}

#[tokio::test]
async fn forgets_the_device_agent_when_the_guest_is_destroyed() {
    let session = fake_session();
    let service = SigninAgents::new();
    service.use_browser_agents(session.clone(), "ostia", &host());
    let guest = fake_guest(Answer::Never);
    follow(&service, &guest, None);
    service.set_device_agent(guest.id, Some(device()));
    service.guest_destroyed(guest.id);
    assert_eq!(
        send_to(&session, "https://example.com/", Some(guest.id)),
        REWRITTEN
    );
}
