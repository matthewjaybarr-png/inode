#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--default on|off|status` is a plain command-line job: no window, no Tauri.
    #[cfg(target_os = "linux")]
    if let Some(code) = inode_lib::setup::cli(&std::env::args().collect::<Vec<_>>()) {
        std::process::exit(code);
    }
    inode_lib::run()
}
