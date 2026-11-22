#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--clip-hold` serves files Inode put on the clipboard (see clip::write): no window, no Tauri.
    #[cfg(not(windows))]
    if std::env::args().nth(1).as_deref() == Some("--clip-hold") {
        std::process::exit(inode_lib::clip::hold());
    }
    // `--default on|off|status` is a plain command-line job: no window, no Tauri.
    #[cfg(target_os = "linux")]
    if let Some(code) = inode_lib::setup::cli(&std::env::args().collect::<Vec<_>>()) {
        std::process::exit(code);
    }
    inode_lib::run()
}
