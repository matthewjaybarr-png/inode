mod choice;
mod clip;
#[cfg(target_os = "linux")]
mod dbus;
mod desktop;
mod fs;
mod ops;
#[cfg(target_os = "linux")]
pub mod setup;
mod shell;

use tauri::{Emitter, Manager};

type R<T> = Result<T, String>;

/// Async so a slow folder (network drive, huge directory) never freezes the window.
#[tauri::command]
async fn list_dir(path: String) -> R<fs::Listing> {
    fs::list(&path)
}

/// Subtree name search, off the UI thread; at most 500 hits.
#[tauri::command]
async fn search(root: String, query: String, hidden: bool) -> R<fs::Found> {
    tauri::async_runtime::spawn_blocking(move || fs::search(&root, &query, hidden, 500)).await.map_err(|e| e.to_string())?
}

/// First 64 KB of a file for the preview column; None when it looks binary (contains a NUL byte).
#[tauri::command]
async fn read_text(path: String) -> R<Option<String>> {
    use std::io::Read;
    let mut buf = Vec::with_capacity(65536);
    std::fs::File::open(&path).and_then(|f| f.take(65536).read_to_end(&mut buf)).map_err(|e| e.to_string())?;
    Ok(decode_text(&buf))
}

/// UTF-16 with a BOM (Windows PowerShell and older Notepad write it) is text; otherwise a NUL byte means binary.
fn decode_text(buf: &[u8]) -> Option<String> {
    let wide = |be: bool| {
        let u: Vec<u16> = buf[2..].chunks_exact(2).map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) }).collect();
        Some(String::from_utf16_lossy(&u))
    };
    match buf {
        [0xFF, 0xFE, ..] => wide(false),
        [0xFE, 0xFF, ..] => wide(true),
        _ => (!buf.contains(&0)).then(|| String::from_utf8_lossy(buf).into_owned()),
    }
}

#[cfg(test)]
mod text_tests {
    #[test]
    fn utf16_bom_is_text_nul_is_binary() {
        assert_eq!(super::decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]).as_deref(), Some("hi"));
        assert_eq!(super::decode_text(&[0xFE, 0xFF, 0, b'h', 0, b'i']).as_deref(), Some("hi"));
        assert_eq!(super::decode_text(b"plain").as_deref(), Some("plain"));
        assert_eq!(super::decode_text(&[1, 0, 2]), None);
    }
}

#[tauri::command]
fn places() -> Vec<fs::Place> {
    fs::places()
}

#[tauri::command]
async fn eject(path: String) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || fs::eject(&path)).await.map_err(|e| e.to_string())?
}

/// Whether a sidebar location answers right now (offline network drives and pins are greyed out).
#[tauri::command]
async fn probe(path: String) -> &'static str {
    tauri::async_runtime::spawn_blocking(move || fs::reachable(path)).await.unwrap_or("")
}

#[tauri::command]
async fn open_path(path: String) -> R<()> {
    fs::open(&path)
}

#[tauri::command]
async fn open_terminal(dir: String) -> R<()> {
    fs::open_terminal(&dir)
}

/// Per window label: the folder it was asked to open (None = wherever the user left off) and the item to put the cursor on.
#[derive(Default)]
struct Starts(std::sync::Mutex<std::collections::HashMap<String, (Option<String>, Option<String>)>>);

/// `[folder, item]` for the calling window (see Starts).
#[tauri::command]
fn startup_path(window: tauri::Window, starts: tauri::State<Starts>) -> (Option<String>, Option<String>) {
    starts.0.lock().unwrap().get(window.label()).cloned().unwrap_or_default()
}

/// A `file://` URI as a path (percent-decoded); None for anything else.
fn file_uri(uri: &str) -> Option<std::path::PathBuf> {
    uri.starts_with("file://").then(|| tauri::Url::parse(uri).ok()?.to_file_path().ok()).flatten()
}

/// The folder a command line asks for: the first non-flag argument (xdg-open / Win+E pass one), relative to `cwd`.
fn arg_path(args: &[String], cwd: &str) -> Option<String> {
    let a = args.iter().skip(1).find(|a| !a.starts_with('-'))?;
    Some(fs::s(&file_uri(a).unwrap_or_else(|| std::path::Path::new(cwd).join(a))))
}

/// Opens one more window, each with its own label. Built on its own thread: creating a window
/// straight from a command or a plugin callback can deadlock on Windows.
fn open_window(app: &tauri::AppHandle, path: Option<String>, select: Option<String>) {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let mut cfg = app.config().app.windows[0].clone();
    cfg.label = format!("w{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    app.state::<Starts>().0.lock().unwrap().insert(cfg.label.clone(), (path, select));
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = tauri::WebviewWindowBuilder::from_config(&app, &cfg).and_then(|b| b.build()) {
            eprintln!("inode: could not open a window: {e}");
        }
    });
}

#[tauri::command]
async fn new_window(app: tauri::AppHandle, path: Option<String>) {
    open_window(&app, path, None)
}

#[cfg(all(test, unix))]
mod arg_tests {
    #[test]
    fn folder_argument_is_resolved() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::arg_path(&args(&["inode", "--flag", "file:///tmp/a%20b"]), "/home/u").as_deref(), Some("/tmp/a b"));
        assert_eq!(super::arg_path(&args(&["inode", "docs"]), "/home/u").as_deref(), Some("/home/u/docs"));
        assert_eq!(super::arg_path(&args(&["inode", "/etc"]), "/home/u").as_deref(), Some("/etc"));
        assert_eq!(super::arg_path(&args(&["inode", "--service"]), "/home/u"), None);
    }
}

#[tauri::command]
async fn conflicts(sources: Vec<String>, dest: String) -> Vec<String> {
    ops::conflicts(&sources, &dest)
}

/// Puts the files on the system clipboard for other apps (see clip.rs for what each platform is given); `mv` = it is a cut.
#[tauri::command]
async fn clip_write(paths: Vec<String>, uris: String, mv: bool) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || clip::write(&paths, &uris, mv)).await.map_err(|e| e.to_string())?
}

/// The files on the system clipboard as file: URI lines ("" = none); Err when it cannot be read at all.
#[tauri::command]
async fn clip_read() -> R<String> {
    tauri::async_runtime::spawn_blocking(clip::read).await.map_err(|e| e.to_string())?
}

/// Whether two paths are on the same drive or device: a drag between them moves, across them it copies.
#[tauri::command]
async fn same_device(a: String, b: String) -> bool {
    fs::same_device(&a, &b)
}

#[derive(serde::Serialize, Clone)]
struct OpProgress<'a> {
    done: u64,
    total: u64,
    name: &'a str,
}

/// Copy or move into `dest`; streams "op-progress" events (at most ~10 a second) while it runs.
#[tauri::command]
async fn transfer(app: tauri::AppHandle, sources: Vec<String>, dest: String, mv: bool, policy: ops::Policy) -> R<Vec<(String, String)>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = std::time::Instant::now();
        ops::transfer(&sources, &dest, mv, policy, &mut |done, total, name| {
            if last.elapsed().as_millis() >= 100 || done == total {
                last = std::time::Instant::now();
                let _ = app.emit("op-progress", OpProgress { done, total, name });
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn props(path: String, deep: Option<bool>) -> R<fs::Props> {
    tauri::async_runtime::spawn_blocking(move || fs::props(&path, deep.unwrap_or(true))).await.map_err(|e| e.to_string())?
}

/// Writes `text` as a new file `name` in `dir`: "name (2)" when taken, never over an existing file. Returns its path.
fn write_free(dir: &str, name: &str, text: &str) -> R<String> {
    use std::io::Write;
    let d = std::path::Path::new(dir);
    let p = if d.join(name).symlink_metadata().is_ok() { ops::free_name(d, name, false) } else { d.join(name) };
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&p).map_err(|e| format!("Cannot write {}: {e}", fs::s(&p)))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("Cannot write {}: {e}", fs::s(&p)))?;
    Ok(fs::s(&p))
}

/// Export settings: the UI's settings as inode-settings.json in `dir`.
#[tauri::command]
async fn save_settings(dir: String, text: String) -> R<String> {
    write_free(&dir, "inode-settings.json", &text)
}

#[cfg(test)]
mod settings_tests {
    #[test]
    fn a_taken_name_gets_a_number_and_nothing_is_overwritten() {
        let d = std::env::temp_dir().join(format!("inode-settings-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let dir = d.to_string_lossy();
        let a = super::write_free(&dir, "inode-settings.json", "one").unwrap();
        let b = super::write_free(&dir, "inode-settings.json", "two").unwrap();
        assert!(a.ends_with("inode-settings.json") && b.ends_with("inode-settings (2).json"));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "two");
        std::fs::remove_dir_all(&d).unwrap();
    }
}

#[tauri::command]
async fn apps_for(path: String) -> Vec<fs::App> {
    tauri::async_runtime::spawn_blocking(move || fs::apps_for(&path)).await.unwrap_or_default()
}

#[tauri::command]
async fn open_with(path: String, app: Option<String>) -> R<()> {
    fs::open_with(&path, app.as_deref())
}

/// Zips the items into a new .zip beside them; streams "op-progress" like transfer.
#[tauri::command]
async fn compress(app: tauri::AppHandle, sources: Vec<String>) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = std::time::Instant::now();
        ops::compress(&sources, &mut |done, total, name| {
            if last.elapsed().as_millis() >= 100 || done == total {
                last = std::time::Instant::now();
                let _ = app.emit("op-progress", OpProgress { done, total, name });
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn move_back(pairs: Vec<(String, String)>) -> R<()> {
    ops::move_back(&pairs)
}

#[tauri::command]
async fn rename_path(path: String, name: String) -> R<String> {
    ops::rename(&path, &name)
}

/// A new empty folder or file; `name` is only given by redo (the first free "New folder" / "New file.txt" otherwise).
#[tauri::command]
async fn new_item(dir: String, name: Option<String>, folder: bool) -> R<String> {
    ops::make_new(&dir, name.as_deref(), folder)
}

/// Unpacks an archive beside itself (into `folder`, or loose when none); returns what it made, for undo_extract.
#[tauri::command]
async fn extract(archive: String, folder: Option<String>) -> R<Vec<ops::Made>> {
    tauri::async_runtime::spawn_blocking(move || ops::extract(&archive, folder.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn undo_extract(made: Vec<ops::Made>) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || ops::undo_extract(&made)).await.map_err(|e| e.to_string())?
}

/// Trash view: put items back (no paths = all of them).
#[tauri::command]
async fn trash_restore(paths: Option<Vec<String>>) -> R<Vec<String>> {
    ops::restore_stored(paths.as_deref())
}

/// Trash view: delete items for good (no paths = empty the trash).
#[tauri::command]
async fn trash_purge(paths: Option<Vec<String>>) -> R<usize> {
    tauri::async_runtime::spawn_blocking(move || ops::purge(paths.as_deref())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn trash(paths: Vec<String>) -> R<ops::TrashReport> {
    Ok(ops::trash(&paths))
}

#[tauri::command]
async fn has_bin(dir: String) -> bool {
    ops::has_bin(&dir)
}

#[tauri::command]
async fn remove_empty(path: String) -> R<()> {
    ops::remove_empty(&path)
}

#[tauri::command]
async fn restore(items: Vec<ops::Trashed>) -> R<Vec<String>> {
    ops::restore(&items)
}

#[tauri::command]
async fn delete_paths(paths: Vec<String>) -> R<()> {
    ops::delete(&paths)
}

/// The theme choice (see choice.rs).
#[tauri::command]
async fn theme_choice() -> serde_json::Value {
    choice::theme()
}

/// scope "app" sets this app's own theme, anything else the suite theme; no value = back to the suite / the default.
#[tauri::command]
async fn set_theme_choice(scope: String, value: Option<String>) -> Result<(), String> {
    choice::set_theme(scope == "app", value.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `--service` (D-Bus activation) runs with no window until a FileManager1 call asks for one.
    let launch = |app: &tauri::AppHandle, args: &[String], cwd: &str| {
        if !args.iter().any(|a| a == "--service") {
            open_window(app, arg_path(args, cwd), None);
        }
    };
    tauri::Builder::default()
        // A second `inode [path]` hands its arguments to the running one, which opens the window.
        .plugin(tauri_plugin_single_instance::init(move |app, args, cwd| launch(app, &args, &cwd)))
        .manage(Starts::default())
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            dbus::serve(app.handle());
            let cwd = std::env::current_dir().unwrap_or_default();
            launch(app.handle(), &std::env::args().collect::<Vec<_>>(), &cwd.to_string_lossy());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![new_window, theme_choice, set_theme_choice, list_dir, places, open_path, open_terminal, startup_path, desktop::desktop_theme, conflicts, transfer, move_back, rename_path, new_item, extract, undo_extract, trash_restore, trash_purge, trash, has_bin, remove_empty, restore, delete_paths, read_text, probe, search, eject, props, save_settings, apps_for, open_with, compress, clip_write, clip_read, same_device, shell::make_link, shell::link_dir, shell::thumb, shell::drag_out])
        .run(tauri::generate_context!())
        .expect("error while running Inode");
}
