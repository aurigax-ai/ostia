#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ostia_contract::clipboard_capture::ClipboardCapture;
use ostia_contract::clipboard_chords::{ClipboardEdit, GuestKeyInput};
use ostia_contract::modifier_remap::{
    ModifierFlags, ModifierRemap, RemapKey, is_identity_remap, parse_modifier_remap, release_stale,
    remapped_flags, same_flags, track_modifier_key,
};
use ostia_workspaces::clipboard_edits::{
    ClipboardContents, ClipboardEdits, ClipboardEditsDeps, ClipboardSnapshot, GuestRemap,
    WebContents, clipboard_contents, clipboard_item_data, file_paths_from_uri_list,
    is_image_format,
};
use serde_json::{Value, json};

struct FakeContents {
    id: u64,
    copies: AtomicUsize,
    pastes: AtomicUsize,
}

impl FakeContents {
    fn new(id: u64) -> Arc<Self> {
        Arc::new(Self {
            id,
            copies: AtomicUsize::new(0),
            pastes: AtomicUsize::new(0),
        })
    }

    fn copy_count(&self) -> usize {
        self.copies.load(Ordering::SeqCst)
    }

    fn paste_count(&self) -> usize {
        self.pastes.load(Ordering::SeqCst)
    }
}

impl WebContents for FakeContents {
    fn id(&self) -> u64 {
        self.id
    }

    fn copy(&self) {
        self.copies.fetch_add(1, Ordering::SeqCst);
    }

    fn paste_and_match_style(&self) {
        self.pastes.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct TestRemap {
    table: Mutex<ModifierRemap>,
    held: Mutex<BTreeMap<u64, BTreeSet<RemapKey>>>,
    forgotten: Mutex<Vec<u64>>,
}

impl TestRemap {
    fn set(&self, raw: Value) {
        *self.table.lock().unwrap() = parse_modifier_remap(&raw);
    }

    fn forgotten(&self) -> Vec<u64> {
        self.forgotten.lock().unwrap().clone()
    }
}

impl GuestRemap for TestRemap {
    fn remap(&self, guest_id: u64, input: &GuestKeyInput) -> GuestKeyInput {
        if input.kind != "keyDown" && input.kind != "keyUp" {
            return input.clone();
        }
        let mut held = self.held.lock().unwrap();
        let down = held.entry(guest_id).or_default();
        track_modifier_key(down, &input.code, input.kind == "keyDown");
        let real = ModifierFlags {
            ctrl: input.control,
            alt: input.alt,
            meta: input.meta,
        };
        release_stale(down, real);
        let table = self.table.lock().unwrap();
        if is_identity_remap(&table) {
            return input.clone();
        }
        let next = remapped_flags(&table, down, real);
        if same_flags(real, next) {
            return input.clone();
        }
        GuestKeyInput {
            control: next.ctrl,
            alt: next.alt,
            meta: next.meta,
            remapped: true,
            ..input.clone()
        }
    }

    fn forget(&self, guest_id: u64) {
        self.held.lock().unwrap().remove(&guest_id);
        self.forgotten.lock().unwrap().push(guest_id);
    }
}

const APP_WINDOW: u64 = 1;

struct Harness {
    app: Arc<FakeContents>,
    edits: ClipboardEdits,
    remap: Arc<TestRemap>,
    written: Arc<Mutex<Vec<ClipboardCapture>>>,
    viewer_copies: Arc<AtomicUsize>,
}

impl Harness {
    fn viewer_copy_count(&self) -> usize {
        self.viewer_copies.load(Ordering::SeqCst)
    }
}

fn setup(formats: &[&str], mac: bool, uri_list: &str, viewer_selection: bool) -> Harness {
    let written = Arc::new(Mutex::new(Vec::new()));
    let viewer_copies = Arc::new(AtomicUsize::new(0));
    let remap = Arc::new(TestRemap::default());
    let snapshot = ClipboardSnapshot {
        formats: formats.iter().map(|format| (*format).to_owned()).collect(),
        uri_list: uri_list.to_owned(),
    };
    let sink = written.clone();
    let counter = viewer_copies.clone();
    let edits = ClipboardEdits::register(ClipboardEditsDeps {
        is_app_window: Arc::new(|id| id == APP_WINDOW),
        snapshot: Arc::new(move || {
            let snapshot = snapshot.clone();
            Box::pin(async move { snapshot })
        }),
        write: Arc::new(move |capture| {
            let sink = sink.clone();
            Box::pin(async move {
                sink.lock().unwrap().push(capture);
            })
        }),
        mac,
        remap: remap.clone(),
        copy_viewer_selection: Arc::new(move |_guest| {
            if viewer_selection {
                counter.fetch_add(1, Ordering::SeqCst);
            }
            viewer_selection
        }),
    });
    Harness {
        app: FakeContents::new(APP_WINDOW),
        edits,
        remap,
        written,
        viewer_copies,
    }
}

fn plain_setup() -> Harness {
    setup(&[], false, "", false)
}

fn mac_setup() -> Harness {
    setup(&[], true, "", false)
}

fn chord(ctrl: bool, shift: bool, meta: bool, key: &str) -> Value {
    json!({"ctrl": ctrl, "shift": shift, "alt": false, "meta": meta, "key": key})
}

fn linux_chords() -> Value {
    json!({"copy": chord(true, true, false, "c"), "paste": chord(true, true, false, "v")})
}

fn mac_chords() -> Value {
    json!({"copy": chord(false, false, true, "c"), "paste": chord(false, false, true, "v")})
}

fn stealing_chords() -> Value {
    json!({"copy": chord(true, false, false, "c"), "paste": null})
}

fn press(harness: &Harness, guest: &FakeContents, adjust: impl FnOnce(&mut GuestKeyInput)) -> bool {
    let mut input = GuestKeyInput {
        kind: "keyDown".to_owned(),
        key: "c".to_owned(),
        code: "KeyC".to_owned(),
        ..GuestKeyInput::default()
    };
    adjust(&mut input);
    harness.edits.guest_input(guest, &input)
}

fn ctrl(input: &mut GuestKeyInput) {
    input.control = true;
}

fn ctrl_shift(input: &mut GuestKeyInput) {
    input.control = true;
    input.shift = true;
}

fn cmd(input: &mut GuestKeyInput) {
    input.meta = true;
}

fn shifted_paste(input: &mut GuestKeyInput) {
    input.control = true;
    input.shift = true;
    input.key = "V".to_owned();
    input.code = "KeyV".to_owned();
}

#[test]
fn copies_and_pastes_on_the_sender_only_for_an_app_window_and_a_known_edit() {
    let harness = plain_setup();
    harness.edits.edit(&*harness.app, ClipboardEdit::Copy);
    harness.edits.edit(&*harness.app, ClipboardEdit::Paste);
    assert_eq!(harness.app.copy_count(), 1);
    assert_eq!(harness.app.paste_count(), 1);
    let stranger = FakeContents::new(2);
    harness.edits.edit(&*stranger, ClipboardEdit::Paste);
    assert_eq!(stranger.paste_count(), 0);
}

#[tokio::test]
async fn writes_a_validated_capture_for_an_app_window_only() {
    let harness = plain_setup();
    let capture = ClipboardCapture {
        text: Some("a,b".to_owned()),
        html: Some("<table></table>".to_owned()),
        png: None,
    };
    assert!(
        harness
            .edits
            .write_capture(&*harness.app, capture.clone())
            .await
    );
    assert_eq!(*harness.written.lock().unwrap(), vec![capture]);
    let stranger = FakeContents::new(2);
    let text_only = ClipboardCapture {
        text: Some("x".to_owned()),
        html: None,
        png: None,
    };
    assert!(!harness.edits.write_capture(&*stranger, text_only).await);
    let fake_png = ClipboardCapture {
        text: None,
        html: None,
        png: Some(vec![0; 12]),
    };
    assert!(!harness.edits.write_capture(&*harness.app, fake_png).await);
    let empty = ClipboardCapture {
        text: None,
        html: None,
        png: None,
    };
    assert!(!harness.edits.write_capture(&*harness.app, empty).await);
    assert_eq!(harness.written.lock().unwrap().len(), 1);
}

#[test]
fn maps_a_capture_to_one_clipboard_item_per_format() {
    let data = clipboard_item_data(&ClipboardCapture {
        text: Some("a".to_owned()),
        html: Some("<b>a</b>".to_owned()),
        png: Some(vec![0x89, 0x50]),
    });
    let keys: Vec<&str> = data.iter().map(|(mime, _)| mime.as_str()).collect();
    assert_eq!(keys, vec!["text/plain", "text/html", "image/png"]);
    assert_eq!(data[0].1, b"a".to_vec());
    let text_only = clipboard_item_data(&ClipboardCapture {
        text: Some("a".to_owned()),
        html: None,
        png: None,
    });
    let keys: Vec<&str> = text_only.iter().map(|(mime, _)| mime.as_str()).collect();
    assert_eq!(keys, vec!["text/plain"]);
}

#[tokio::test]
async fn reports_the_clipboard_contents_only_to_an_app_window() {
    let harness = setup(&["image/png"], false, "", false);
    assert_eq!(
        harness.edits.contents(&*harness.app).await,
        ClipboardContents {
            files: vec![],
            image: true
        }
    );
    assert_eq!(
        harness.edits.contents(&*FakeContents::new(2)).await,
        ClipboardContents {
            files: vec![],
            image: false
        }
    );
    let text = setup(&["text/plain"], false, "", false);
    assert_eq!(
        text.edits.contents(&*text.app).await,
        ClipboardContents {
            files: vec![],
            image: false
        }
    );
}

#[tokio::test]
async fn reports_a_copied_file_and_its_native_image_types_the_way_finder_leaves_them() {
    let finder = setup(
        &[
            "text/uri-list",
            "electron application/osclipboard;format=\"Apple PNG pasteboard type\"",
            "electron application/osclipboard;format=\"NeXT TIFF v4.0 pasteboard type\"",
        ],
        true,
        "file:///Users/me/Desktop/my%20shot.png\r\n",
        false,
    );
    assert_eq!(
        finder.edits.contents(&*finder.app).await,
        ClipboardContents {
            files: vec![PathBuf::from("/Users/me/Desktop/my shot.png")],
            image: true
        }
    );
}

#[test]
fn runs_the_chords_the_renderer_sent_inside_a_guest_page() {
    let harness = plain_setup();
    let guest = FakeContents::new(5);
    assert!(!press(&harness, &guest, ctrl_shift));
    harness.edits.set_chords(&*harness.app, &linux_chords());
    assert!(press(&harness, &guest, ctrl_shift));
    assert_eq!(guest.copy_count(), 1);
    press(&harness, &guest, shifted_paste);
    assert_eq!(guest.paste_count(), 1);
    assert!(!press(&harness, &guest, ctrl));
}

mod a_viewer_guest_with_a_stored_selection {
    use super::*;

    fn viewer(mac: bool, stored: bool) -> (Harness, Arc<FakeContents>) {
        let harness = setup(&[], mac, "", stored);
        let guest = FakeContents::new(5);
        let chords = if mac { mac_chords() } else { linux_chords() };
        harness.edits.set_chords(&*harness.app, &chords);
        (harness, guest)
    }

    #[test]
    fn copies_from_main_once_and_keeps_the_native_copy_out_of_it() {
        type Adjust = fn(&mut GuestKeyInput);
        let rows: [(&str, bool, Adjust); 3] = [
            ("the app copy chord", false, ctrl_shift),
            ("plain Ctrl+C", false, ctrl),
            ("plain Cmd+C", true, cmd),
        ];
        for (name, mac, input) in rows {
            let (harness, guest) = viewer(mac, true);
            assert!(press(&harness, &guest, input), "{name}");
            assert_eq!(harness.viewer_copy_count(), 1, "{name}");
            assert_eq!(guest.copy_count(), 0, "{name}");
        }
    }

    #[test]
    fn copies_from_main_for_control_remapped_to_command() {
        let (harness, guest) = viewer(true, true);
        harness.remap.set(json!({"ControlRight": "command"}));
        press(&harness, &guest, |input| {
            input.key = "Control".to_owned();
            input.code = "ControlRight".to_owned();
            input.control = true;
        });
        assert!(press(&harness, &guest, ctrl));
        assert_eq!(harness.viewer_copy_count(), 1);
        assert_eq!(guest.copy_count(), 0);
    }

    #[test]
    fn copies_nothing_from_main_without_a_selection_the_app_chord_copies_natively_plain_keys_stay_with_the_page()
     {
        let (linux, linux_guest) = viewer(false, false);
        assert!(press(&linux, &linux_guest, ctrl_shift));
        assert_eq!(linux_guest.copy_count(), 1);
        assert!(!press(&linux, &linux_guest, ctrl));
        assert_eq!(linux_guest.copy_count(), 1);
        let (mac, mac_guest) = viewer(true, false);
        assert!(!press(&mac, &mac_guest, cmd));
        assert_eq!(mac_guest.copy_count(), 0);
    }

    #[test]
    fn does_not_treat_other_keys_as_a_copy() {
        let (harness, guest) = viewer(false, true);
        press(&harness, &guest, |input| {
            input.control = true;
            input.key = "x".to_owned();
            input.code = "KeyX".to_owned();
        });
        press(&harness, &guest, |input| {
            input.control = true;
            input.alt = true;
        });
        press(&harness, &guest, |input| {
            input.control = true;
            input.meta = true;
        });
        press(&harness, &guest, |input| {
            input.control = true;
            input.key = "v".to_owned();
            input.code = "KeyV".to_owned();
        });
        press(&harness, &guest, |input| {
            input.control = true;
            input.kind = "keyUp".to_owned();
        });
        assert_eq!(harness.viewer_copy_count(), 0);
        assert_eq!(guest.copy_count(), 0);
    }

    #[test]
    fn pastes_natively_as_before() {
        let (harness, guest) = viewer(false, true);
        press(&harness, &guest, shifted_paste);
        assert_eq!(guest.paste_count(), 1);
    }
}

#[test]
fn copies_for_a_key_remapped_to_command_which_the_system_menu_never_sees_and_leaves_a_real_cmd_c_to_the_page()
 {
    let harness = mac_setup();
    let guest = FakeContents::new(5);
    harness.edits.set_chords(&*harness.app, &mac_chords());
    harness.remap.set(json!({"ControlRight": "command"}));
    assert!(!press(&harness, &guest, cmd));
    press(&harness, &guest, |input| {
        input.key = "Control".to_owned();
        input.code = "ControlRight".to_owned();
        input.control = true;
    });
    assert!(press(&harness, &guest, ctrl));
    assert_eq!(guest.copy_count(), 1);
}

#[test]
fn copies_for_option_remapped_to_command_on_a_layout_where_option_c_types_a_cedilla() {
    let harness = mac_setup();
    let guest = FakeContents::new(5);
    harness.edits.set_chords(&*harness.app, &mac_chords());
    harness.remap.set(json!({"AltLeft": "command"}));
    press(&harness, &guest, |input| {
        input.key = "Alt".to_owned();
        input.code = "AltLeft".to_owned();
        input.alt = true;
    });
    assert!(press(&harness, &guest, |input| {
        input.key = "ç".to_owned();
        input.alt = true;
    }));
    assert_eq!(guest.copy_count(), 1);
}

#[test]
fn forgets_the_held_keys_of_a_guest_that_is_destroyed() {
    let harness = mac_setup();
    let guest = FakeContents::new(5);
    harness.edits.guest_destroyed(guest.id());
    assert_eq!(harness.remap.forgotten(), vec![5]);
}

#[test]
fn ignores_chords_from_a_stranger_or_a_payload_that_would_steal_a_terminal_key() {
    let harness = plain_setup();
    let guest = FakeContents::new(5);
    harness
        .edits
        .set_chords(&*FakeContents::new(2), &linux_chords());
    harness.edits.set_chords(&*harness.app, &stealing_chords());
    press(&harness, &guest, ctrl);
    press(&harness, &guest, ctrl_shift);
    assert_eq!(guest.copy_count(), 0);
}

#[test]
fn keeps_the_chords_it_already_had_when_a_later_payload_is_rejected() {
    let harness = plain_setup();
    let guest = FakeContents::new(5);
    harness.edits.set_chords(&*harness.app, &linux_chords());
    harness.edits.set_chords(&*harness.app, &stealing_chords());
    harness.edits.set_chords(&*harness.app, &json!("nonsense"));
    harness.edits.set_chords(
        &*FakeContents::new(2),
        &json!({"copy": null, "paste": null}),
    );
    assert!(press(&harness, &guest, ctrl_shift));
    assert_eq!(guest.copy_count(), 1);
    assert!(!press(&harness, &guest, ctrl));
}

#[test]
fn leaves_cmd_c_and_cmd_v_native_in_a_guest_on_macos_even_when_sent_as_chords() {
    let harness = mac_setup();
    let guest = FakeContents::new(5);
    harness.edits.set_chords(&*harness.app, &mac_chords());
    let copy = press(&harness, &guest, cmd);
    let paste = press(&harness, &guest, |input| {
        input.meta = true;
        input.key = "v".to_owned();
        input.code = "KeyV".to_owned();
    });
    assert!(!copy);
    assert!(!paste);
    assert_eq!(guest.copy_count(), 0);
    assert_eq!(guest.paste_count(), 0);
}

mod clipboard_contents_of_a_snapshot {
    use super::*;

    #[test]
    fn sees_an_image_in_the_native_macos_types_electron_reports_when_no_image_mime_type_exists() {
        for format in [
            "electron application/osclipboard;format=\"public.png\"",
            "electron application/osclipboard;format=\"public.tiff\"",
            "electron application/osclipboard;format=\"Apple PNG pasteboard type\"",
            "electron application/osclipboard;format=\"NeXT TIFF v4.0 pasteboard type\"",
        ] {
            let contents = clipboard_contents(&ClipboardSnapshot {
                formats: vec!["text/uri-list".to_owned(), format.to_owned()],
                uri_list: String::new(),
            });
            assert!(contents.image, "{format}");
        }
    }

    #[test]
    fn does_not_take_other_raw_formats_or_plain_text_for_an_image() {
        assert!(!is_image_format(
            "electron application/osclipboard;format=\"public.utf8-plain-text\""
        ));
        assert!(!is_image_format("text/plain"));
        assert_eq!(
            clipboard_contents(&ClipboardSnapshot {
                formats: vec!["text/plain".to_owned()],
                uri_list: String::new(),
            }),
            ClipboardContents {
                files: vec![],
                image: false
            }
        );
    }

    #[test]
    fn lists_every_local_file_in_the_uri_list_and_skips_comments_and_web_links() {
        assert_eq!(
            file_paths_from_uri_list(
                "# copied\r\nfile:///tmp/a%20b.png\r\nhttps://example.com/x.png\nfile:///tmp/c.txt\n"
            ),
            vec![PathBuf::from("/tmp/a b.png"), PathBuf::from("/tmp/c.txt")]
        );
    }

    #[test]
    fn skips_a_file_url_that_names_another_host() {
        assert_eq!(
            file_paths_from_uri_list("file://server/share/a.png"),
            Vec::<PathBuf>::new()
        );
    }

    #[test]
    fn reports_a_file_together_with_an_image_which_the_renderer_pastes_as_a_path() {
        assert_eq!(
            clipboard_contents(&ClipboardSnapshot {
                formats: vec!["image/png".to_owned(), "text/uri-list".to_owned()],
                uri_list: "file:///tmp/a.png".to_owned(),
            }),
            ClipboardContents {
                files: vec![PathBuf::from("/tmp/a.png")],
                image: true
            }
        );
    }
}
