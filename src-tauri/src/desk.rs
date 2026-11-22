//! Commands of the Linux desktop pieces: the file chooser portal (portal.rs) and network places, phones and
//! encrypted drives (mounts.rs). They exist on every platform so the handler list is one list; elsewhere they say no.
type R<T> = Result<T, String>;

#[cfg(not(target_os = "linux"))]
const NO: &str = "Inode does this on Linux only";

/// The file chooser request this window was opened for; None in an ordinary window.
#[tauri::command]
pub fn pick_request(window: tauri::Window) -> Option<serde_json::Value> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let picks = window.try_state::<crate::portal::Picks>()?;
        let open = picks.0.lock().unwrap();
        serde_json::to_value(&open.get(window.label())?.0).ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        None
    }
}

/// The picker window's answer: the chosen paths and the filter in use; no paths = cancelled. The portal closes the window.
#[tauri::command]
pub fn pick_done(window: tauri::Window, paths: Option<Vec<String>>, filter: usize) {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        if let Some((_, tx)) = window.try_state::<crate::portal::Picks>().and_then(|p| p.0.lock().unwrap().get(window.label()).cloned()) {
            let _ = tx.try_send(paths.map(|p| (p, filter)));
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (window, paths, filter);
}

/// Mounts a network address or plugged-in phone and returns its folder. See mounts::connect for the "auth:" and
/// "trust:" errors the UI answers. The password goes nowhere but that one call.
#[tauri::command]
pub async fn connect(address: String, user: Option<String>, password: Option<String>, trust: bool) -> R<String> {
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(move || crate::mounts::connect(&address, user.as_deref(), password.as_deref(), trust)).await.map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (address, user, password, trust);
        Err(NO.into())
    }
}

/// Makes a new locked folder in `dir`; returns [its path, the recovery key]. The password goes nowhere but gocryptfs.
#[tauri::command]
pub async fn make_locked(dir: String, name: String, password: String) -> R<(String, String)> {
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(move || crate::mounts::make_locked(&dir, &name, &password)).await.map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (dir, name, password);
        Err(NO.into())
    }
}

/// Locks an existing folder in place (the original goes to the Trash); returns [its path, the recovery key].
#[tauri::command]
pub async fn lock_existing(folder: String, password: String) -> R<(String, String)> {
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(move || crate::mounts::lock_existing(&folder, &password)).await.map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (folder, password);
        Err(NO.into())
    }
}

/// Opens a locked folder; returns the folder its readable files are in.
#[tauri::command]
pub async fn unlock_folder(folder: String, password: String) -> R<String> {
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(move || crate::mounts::unlock_folder(&folder, &password)).await.map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (folder, password);
        Err(NO.into())
    }
}

/// Unlocks and mounts a locked encrypted drive; returns its folder.
#[tauri::command]
pub async fn unlock(device: String, passphrase: String) -> R<String> {
    #[cfg(target_os = "linux")]
    return tauri::async_runtime::spawn_blocking(move || crate::mounts::unlock(&device, &passphrase)).await.map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (device, passphrase);
        Err(NO.into())
    }
}
