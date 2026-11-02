use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};

fn main() {
    let answer = MessageDialog::new()
        .set_level(MessageLevel::Info)
        .set_title("ostia spike")
        .set_description("Confirm dialog works?")
        .set_buttons(MessageButtons::YesNo)
        .show();
    println!(
        "message dialog: {answer:?} (yes = {})",
        answer == MessageDialogResult::Yes
    );
    println!(
        "pick_file: {:?}",
        FileDialog::new().set_title("pick one").pick_file()
    );
    println!(
        "save_file: {:?}",
        FileDialog::new().set_file_name("spike.txt").save_file()
    );
}
