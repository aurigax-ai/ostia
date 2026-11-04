#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_contract::file_urls::{FileUrlOpener, FileUrlTarget};
use ostia_model::settings::terminal_pane_settings::LinkClick;
use ostia_model::terminal::ostia_terminal::{TerminalPosition, TerminalRange};
use ostia_model::terminal_links::link_modifier::{
    PathLinkClick, PathLinkContext, PathLinkTarget, WebLinkClick, WebLinkClickContext,
    path_link_target, terminal_link_target,
};
use ostia_model::terminal_links::terminal_app_links::{LinkEvent, WebLinkHandler};
use ostia_model::terminal_links::terminal_file_links::{BufferCell, BufferRow, TerminalBuffer};
use ostia_model::terminal_links::terminal_file_urls::{
    FileUrlAction, FileUrlDeps, FileUrlLink, FileUrlLinks, create_file_url_links, file_url_action,
    file_url_offers, with_file_urls,
};

const PAGE: &str = "file:///Users/j/.cache/meeting-transcribe/results/yushan/speakers.html";
const PAGE_PATH: &str = "/Users/j/.cache/meeting-transcribe/results/yushan/speakers.html";
const INERT: [&str; 6] = [
    "file:///Users/j/run.command",
    "file:///Users/j/Tool.app",
    "file:///Users/j/bin/tool",
    "file:///Users/j/docs/",
    "file:///etc/hosts",
    "file:///tmp/outside.pdf",
];

struct Screen(Vec<BufferRow>);

impl TerminalBuffer for Screen {
    fn len(&self) -> usize {
        self.0.len()
    }

    fn line(&self, y: usize) -> Option<BufferRow> {
        self.0.get(y).cloned()
    }
}

fn fake_terminal(text: &str) -> Arc<Screen> {
    Arc::new(Screen(vec![BufferRow {
        wrapped: false,
        cells: text
            .chars()
            .map(|ch| BufferCell {
                chars: ch.to_string(),
                width: 1,
            })
            .collect(),
    }]))
}

fn target(path: &str, opener: FileUrlOpener) -> FileUrlTarget {
    FileUrlTarget {
        path: path.to_owned(),
        opener,
    }
}

fn page_target() -> FileUrlTarget {
    target(PAGE_PATH, FileUrlOpener::HtmlPage)
}

fn mac_target(event: LinkEvent) -> Option<PathLinkTarget> {
    path_link_target(
        PathLinkClick {
            ctrl: event.ctrl,
            meta: event.meta,
            shift: event.shift,
            alt: event.alt,
        },
        PathLinkContext {
            mac: true,
            link_click: LinkClick::App,
        },
    )
}

fn allowed_answer(url: &str) -> Option<FileUrlTarget> {
    if url == PAGE {
        return Some(page_target());
    }
    if url.ends_with(".pdf") && url.starts_with("file:///Users/") {
        let path = url["file://".len()..].replace("%20", " ");
        return Some(target(&path, FileUrlOpener::DefaultApp));
    }
    None
}

type Checker = Box<dyn Fn(String) -> BoxFuture<'static, Option<FileUrlTarget>> + Send + Sync>;
type Opened = (PathLinkTarget, String, FileUrlTarget, FileUrlAction);
type Hovered = (TerminalRange, FileUrlTarget, FileUrlAction);

#[derive(Default)]
struct Spies {
    checked: Mutex<Vec<String>>,
    opened: Mutex<Vec<Opened>>,
    hovered: Mutex<Vec<Hovered>>,
    left: Mutex<usize>,
}

impl Spies {
    fn checked(&self) -> Vec<String> {
        self.checked.lock().unwrap().clone()
    }

    fn opened(&self) -> Vec<Opened> {
        self.opened.lock().unwrap().clone()
    }

    fn hovered(&self) -> Vec<Hovered> {
        self.hovered.lock().unwrap().clone()
    }

    fn left(&self) -> usize {
        *self.left.lock().unwrap()
    }
}

struct Options {
    remote: bool,
    previews: fn(&FileUrlTarget) -> bool,
    check: Option<Checker>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            remote: false,
            previews: |_| false,
            check: None,
        }
    }
}

fn answering(
    answers: impl Fn(&str) -> Option<FileUrlTarget> + Send + Sync + 'static,
) -> Option<Checker> {
    Some(Box::new(move |url| {
        let found = answers(&url);
        Box::pin(async move { found })
    }))
}

fn file_urls(options: Options) -> (Arc<Spies>, FileUrlLinks) {
    let spies = Arc::new(Spies::default());
    let check = options
        .check
        .unwrap_or_else(|| answering(allowed_answer).unwrap());
    let remote = options.remote;
    let deps = FileUrlDeps {
        remote: Box::new(move || remote),
        check: {
            let spies = spies.clone();
            Box::new(move |url| {
                spies.checked.lock().unwrap().push(url.clone());
                check(url)
            })
        },
        previews: Box::new(options.previews),
        target: Box::new(mac_target),
        activate: {
            let spies = spies.clone();
            Box::new(move |how, url, target, action| {
                spies
                    .opened
                    .lock()
                    .unwrap()
                    .push((how, url, target, action));
            })
        },
        hover: {
            let spies = spies.clone();
            Box::new(move |range, target, action| {
                spies.hovered.lock().unwrap().push((range, target, action));
            })
        },
        leave: {
            let spies = spies.clone();
            Box::new(move || *spies.left.lock().unwrap() += 1)
        },
    };
    (spies, create_file_url_links(deps))
}

async fn links_for(
    text: &str,
    options: Options,
) -> (Arc<Spies>, FileUrlLinks, Option<Vec<FileUrlLink>>) {
    let (spies, links) = file_urls(options);
    let found = links.provider(fake_terminal(text)).provide_links(1).await;
    (spies, links, found)
}

fn human() -> LinkEvent {
    LinkEvent {
        meta: true,
        trusted: true,
        ..LinkEvent::default()
    }
}

fn hover_event() -> LinkEvent {
    LinkEvent::default()
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

fn pos(x: i64, y: i64) -> TerminalPosition {
    TerminalPosition { x, y }
}

fn range() -> TerminalRange {
    TerminalRange {
        start: pos(1, 1),
        end: pos(9, 1),
    }
}

fn texts(found: &Option<Vec<FileUrlLink>>) -> Vec<&str> {
    found.iter().flatten().map(|l| l.text.as_str()).collect()
}

#[derive(Default)]
struct Web {
    activated: Mutex<Vec<String>>,
    hovered: Mutex<Vec<String>>,
}

impl WebLinkHandler for Web {
    fn activate(&self, _event: LinkEvent, uri: &str, _range: TerminalRange) {
        self.activated.lock().unwrap().push(uri.to_owned());
    }

    fn hover(&self, _event: LinkEvent, uri: &str, _range: TerminalRange) {
        self.hovered.lock().unwrap().push(uri.to_owned());
    }

    fn leave(&self, _event: LinkEvent, _uri: &str, _range: TerminalRange) {}
}

mod provider {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn links_the_example_speakers_html_and_opens_it_on_a_human_cmd_click() {
        let text = format!("review {PAGE} now");
        let (spies, _links, found) = links_for(&text, Options::default()).await;
        let found = found.unwrap();
        assert_eq!(found.len(), 1);
        let link = &found[0];
        assert_eq!(link.text, PAGE);
        assert_eq!(
            link.range,
            TerminalRange {
                start: pos(8, 1),
                end: pos(i64::try_from(7 + PAGE.len()).unwrap(), 1),
            }
        );
        link.activate(human());
        settle().await;
        assert_eq!(
            spies.opened(),
            [(
                PathLinkTarget::Open,
                PAGE.to_owned(),
                page_target(),
                FileUrlAction::BrowsePage
            )]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn opens_a_pdf_and_a_png_through_main_on_cmd_click() {
        let pdf = "file:///Users/j/a%20b.pdf";
        let png = "file:///Users/j/shot.png";
        let check = answering(move |url| {
            if url == png {
                Some(target("/Users/j/shot.png", FileUrlOpener::DefaultApp))
            } else {
                allowed_answer(url)
            }
        });
        let (spies, _links, found) = links_for(
            &format!("{pdf} {png}"),
            Options {
                check,
                ..Options::default()
            },
        )
        .await;
        assert_eq!(texts(&found), [pdf, png]);
        for link in found.iter().flatten() {
            link.activate(human());
        }
        settle().await;
        let opened = spies.opened();
        assert!(opened.contains(&(
            PathLinkTarget::Open,
            pdf.to_owned(),
            target("/Users/j/a b.pdf", FileUrlOpener::DefaultApp),
            FileUrlAction::OpenDefault
        )));
        assert!(opened.contains(&(
            PathLinkTarget::Open,
            png.to_owned(),
            target("/Users/j/shot.png", FileUrlOpener::DefaultApp),
            FileUrlAction::OpenDefault
        )));
    }

    #[tokio::test(start_paused = true)]
    async fn leaves_commands_apps_executables_folders_and_files_outside_home_unlinked() {
        let (spies, _links, found) = links_for(&INERT.join(" "), Options::default()).await;
        assert!(found.is_none());
        assert_eq!(spies.checked(), ["file:///tmp/outside.pdf"]);
    }

    #[tokio::test(start_paused = true)]
    async fn asks_main_about_a_hostname_url_linking_the_local_hostname_and_not_another_machine() {
        let local = "file://Mac/Users/j/listing.pdf";
        let other = "file://other-mac/Users/j/listing.pdf";
        let check = answering(move |url| {
            (url == local).then(|| target("/Users/j/listing.pdf", FileUrlOpener::DefaultApp))
        });
        let (spies, _links, found) = links_for(
            &format!("{local} {other}"),
            Options {
                check,
                ..Options::default()
            },
        )
        .await;
        assert_eq!(spies.checked(), [local, other]);
        assert_eq!(texts(&found), [local]);
        for link in found.iter().flatten() {
            link.activate(human());
        }
        settle().await;
        assert_eq!(
            spies.opened(),
            [(
                PathLinkTarget::Open,
                local.to_owned(),
                target("/Users/j/listing.pdf", FileUrlOpener::DefaultApp),
                FileUrlAction::OpenDefault
            )]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn does_nothing_without_the_modifier_for_a_scripted_click_or_in_a_remote_shell() {
        let (spies, _links, found) = links_for(PAGE, Options::default()).await;
        let found = found.unwrap();
        let link = &found[0];
        link.activate(LinkEvent {
            meta: false,
            ..human()
        });
        link.activate(LinkEvent {
            trusted: false,
            ..human()
        });
        settle().await;
        assert!(spies.opened().is_empty());
        let (remote_spies, _links, remote_found) = links_for(
            PAGE,
            Options {
                remote: true,
                ..Options::default()
            },
        )
        .await;
        assert!(remote_found.is_none());
        assert!(remote_spies.checked().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn opens_a_previewable_page_with_the_system_browser_on_cmd_shift_click_and_other_files_only_with_cmd()
     {
        let pdf = "file:///Users/j/a.pdf";
        let (spies, _links, found) = links_for(
            &format!("{PAGE} {pdf}"),
            Options {
                previews: |target| target.opener == FileUrlOpener::HtmlPage,
                ..Options::default()
            },
        )
        .await;
        let found = found.unwrap();
        let (page, doc) = (&found[0], &found[1]);
        page.activate(LinkEvent {
            shift: true,
            ..human()
        });
        doc.activate(LinkEvent {
            shift: true,
            ..human()
        });
        doc.activate(LinkEvent {
            alt: true,
            ..human()
        });
        settle().await;
        assert_eq!(
            spies.opened(),
            [(
                PathLinkTarget::OpenSystem,
                PAGE.to_owned(),
                page_target(),
                FileUrlAction::PreviewPage
            )]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn offers_a_page_outside_the_artifacts_folder_only_with_cmd_since_both_clicks_would_open_the_browser()
     {
        let (spies, _links, found) = links_for(PAGE, Options::default()).await;
        let found = found.unwrap();
        let page = &found[0];
        page.activate(LinkEvent {
            shift: true,
            ..human()
        });
        settle().await;
        assert!(spies.opened().is_empty());
        page.hover();
        settle().await;
        assert_eq!(
            spies.hovered(),
            [(page.range, page_target(), FileUrlAction::BrowsePage)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn hovers_with_the_decoded_real_path_and_stops_once_the_pointer_left() {
        let (spies, _links, found) = links_for(PAGE, Options::default()).await;
        let found = found.unwrap();
        let link = &found[0];
        link.hover();
        settle().await;
        assert_eq!(
            spies.hovered(),
            [(link.range, page_target(), FileUrlAction::BrowsePage)]
        );
        link.leave();
        assert_eq!(spies.left(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn asks_main_once_per_url_within_five_seconds() {
        let (spies, links) = file_urls(Options::default());
        let provider = links.provider(fake_terminal(PAGE));
        provider.provide_links(1).await;
        provider.provide_links(1).await;
        assert_eq!(spies.checked().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn asks_main_again_once_five_seconds_have_passed() {
        let (spies, links) = file_urls(Options::default());
        let provider = links.provider(fake_terminal(PAGE));
        provider.provide_links(1).await;
        tokio::time::sleep(Duration::from_millis(5_001)).await;
        provider.provide_links(1).await;
        assert_eq!(spies.checked().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn treats_a_failed_check_as_no_link() {
        let (_spies, _links, found) = links_for(
            PAGE,
            Options {
                check: answering(|_| None),
                ..Options::default()
            },
        )
        .await;
        assert!(found.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn offers_no_links_on_a_row_without_a_file_url() {
        let (spies, _links, found) = links_for("nothing to open here", Options::default()).await;
        assert!(found.is_none());
        assert!(spies.checked().is_empty());
    }
}

mod with_file_urls_handler {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn sends_file_urls_from_osc_8_hyperlinks_to_the_file_url_checks_and_the_rest_unchanged() {
        let web = Arc::new(Web::default());
        let (spies, links) = file_urls(Options::default());
        let handler = with_file_urls(web.clone(), links);
        handler.hover(hover_event(), PAGE, range());
        settle().await;
        assert_eq!(
            spies.hovered(),
            [(range(), page_target(), FileUrlAction::BrowsePage)]
        );
        handler.activate(human(), PAGE, range());
        settle().await;
        assert_eq!(
            spies.opened(),
            [(
                PathLinkTarget::Open,
                PAGE.to_owned(),
                page_target(),
                FileUrlAction::BrowsePage
            )]
        );
        handler.leave(hover_event(), PAGE, range());
        assert_eq!(spies.left(), 1);
        assert!(web.activated.lock().unwrap().is_empty());
        assert!(web.hovered.lock().unwrap().is_empty());

        handler.activate(human(), "https://a.b", range());
        handler.hover(hover_event(), "https://a.b", range());
        assert_eq!(*web.activated.lock().unwrap(), ["https://a.b"]);
        assert_eq!(*web.hovered.lock().unwrap(), ["https://a.b"]);
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_an_inert_osc_8_file_url_inert_and_never_hands_it_to_the_web_handler() {
        let web = Arc::new(Web::default());
        let (spies, links) = file_urls(Options::default());
        let handler = with_file_urls(web.clone(), links);
        for url in INERT {
            handler.hover(hover_event(), url, range());
            handler.activate(human(), url, range());
        }
        settle().await;
        assert!(spies.opened().is_empty());
        assert!(spies.hovered().is_empty());
        assert!(web.activated.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn drops_a_hover_answer_that_arrives_after_the_pointer_left() {
        let (answer, waiting) = tokio::sync::oneshot::channel::<Option<FileUrlTarget>>();
        let waiting = Arc::new(Mutex::new(Some(waiting)));
        let check: Checker = Box::new(move |_| {
            let waiting = waiting.lock().unwrap().take().unwrap();
            Box::pin(async move { waiting.await.unwrap() })
        });
        let (spies, links) = file_urls(Options {
            check: Some(check),
            ..Options::default()
        });
        links.hover(range(), PAGE);
        links.leave();
        answer.send(Some(page_target())).unwrap();
        settle().await;
        assert!(spies.hovered().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn matches_file_scheme_urls_in_any_letter_case() {
        let web = Arc::new(Web::default());
        let (spies, links) = file_urls(Options::default());
        let handler = with_file_urls(web.clone(), links);
        handler.activate(human(), "FILE:///Users/j/a.pdf", range());
        settle().await;
        assert_eq!(spies.checked(), ["FILE:///Users/j/a.pdf"]);
        assert!(web.activated.lock().unwrap().is_empty());
    }
}

mod file_url_offers {
    use super::*;

    #[test]
    fn previews_html_only_where_ostia_can_show_it_and_otherwise_browses_it_like_any_default_app_file()
     {
        let pdf = target("/Users/j/a.pdf", FileUrlOpener::DefaultApp);
        assert_eq!(
            file_url_action(&page_target(), true),
            FileUrlAction::PreviewPage
        );
        assert_eq!(
            file_url_action(&page_target(), false),
            FileUrlAction::BrowsePage
        );
        assert_eq!(file_url_action(&pdf, true), FileUrlAction::OpenDefault);
        assert_eq!(
            file_url_offers(FileUrlAction::PreviewPage),
            [PathLinkTarget::Open, PathLinkTarget::OpenSystem]
        );
        assert_eq!(
            file_url_offers(FileUrlAction::BrowsePage),
            [PathLinkTarget::Open]
        );
        assert_eq!(
            file_url_offers(FileUrlAction::OpenDefault),
            [PathLinkTarget::Open]
        );
    }

    #[test]
    fn keeps_file_urls_out_of_the_web_and_app_link_targets() {
        let ctx = WebLinkClickContext {
            mac: true,
            has_selection: false,
            mouse_reporting: false,
            link_click: LinkClick::App,
        };
        let click = WebLinkClick {
            ctrl: false,
            meta: true,
            shift: false,
            detail: 1,
        };
        assert_eq!(terminal_link_target(PAGE, click, ctx), None);
    }
}
