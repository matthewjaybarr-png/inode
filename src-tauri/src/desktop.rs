//! Following the desktop theme: Omarchy on Linux, Omarchy Overlay / Orbit on Windows.
use std::fs;
use std::path::PathBuf;

#[derive(serde::Serialize, Default)]
pub struct DesktopTheme {
    source: String,
    /// Omarchy colors.toml text (Linux).
    text: Option<String>,
    /// Theme id chosen in Omarchy Overlay / Orbit (Windows); the UI ships the matching toml in ui/themes.
    id: Option<String>,
}

/// The desktop's current theme, if Omarchy (Linux) or Omarchy Overlay / Orbit (Windows) has one.
#[tauri::command]
pub fn desktop_theme() -> Option<DesktopTheme> {
    if cfg!(windows) {
        for var in ["LOCALAPPDATA", "APPDATA"] {
            let Some(base) = std::env::var_os(var).map(PathBuf::from) else { continue };
            for app in ["OmarchyOverlay", "Orbit", "Keyspace"] {
                let Ok(text) = fs::read_to_string(base.join(app).join("config.json")) else { continue };
                let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                if let Some(id) = json.get("theme").and_then(|t| t.as_str()) {
                    return Some(DesktopTheme { source: app.into(), id: Some(id.into()), ..Default::default() });
                }
            }
        }
        return None;
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let state = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).unwrap_or(home.join(".local/state"));
    [state.join("omarchy/current/theme/colors.toml"), home.join(".config/omarchy/current/theme/colors.toml")]
        .iter()
        .find_map(|p| fs::read_to_string(p).ok())
        .map(|text| DesktopTheme { source: "Omarchy".into(), text: Some(text), ..Default::default() })
}
