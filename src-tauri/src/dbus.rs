//! org.freedesktop.FileManager1 on the session bus: what browsers and other apps call for "show in folder".
use tauri::{AppHandle, Manager};

struct FileManager(AppHandle);

impl FileManager {
    /// One window per folder: `open` maps a path to (folder, item to put the cursor on).
    fn show(&self, uris: Vec<String>, open: impl Fn(std::path::PathBuf) -> (String, Option<String>)) {
        let mut seen = Vec::new();
        for (dir, item) in uris.iter().filter_map(|u| crate::file_uri(u)).map(open) {
            if !seen.contains(&dir) {
                seen.push(dir.clone());
                crate::open_window(&self.0, Some(dir), item);
            }
        }
    }
}

#[zbus::interface(name = "org.freedesktop.FileManager1")]
impl FileManager {
    fn show_folders(&self, uris: Vec<String>, _startup_id: String) {
        self.show(uris, |p| (crate::fs::s(&p), None));
    }

    fn show_items(&self, uris: Vec<String>, _startup_id: String) {
        self.show(uris, |p| (crate::fs::s(p.parent().unwrap_or(&p)), Some(crate::fs::s(&p))));
    }

    // shortcut: shows the item in its folder like ShowItems; open the Properties sheet too if anyone misses it.
    fn show_item_properties(&self, uris: Vec<String>, startup_id: String) {
        self.show_items(uris, startup_id);
    }
}

/// Serves the interface for as long as the app runs. No bus, or another file manager already owning the name: carry on without.
pub fn serve(app: &AppHandle) {
    let Ok(conn) = zbus::blocking::Connection::session() else { return };
    if conn.object_server().at("/org/freedesktop/FileManager1", FileManager(app.clone())).is_ok() {
        // DoNotQueue and no ReplaceExisting: a running file manager keeps the name.
        let _ = conn.request_name_with_flags("org.freedesktop.FileManager1", zbus::fdo::RequestNameFlags::DoNotQueue.into());
    }
    app.manage(conn); // dropping the connection would end the service
}
