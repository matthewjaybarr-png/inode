//! Where the theme choice is kept. Public edition: one small file of Inode's own.
//! (The private work edition replaces this file to share the choice with its suite.)
use std::path::PathBuf;

fn file() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.map(|b| b.join("inode").join("theme.json"))
}

/// `{ suite, own }`, the shape ui/theme.js reads; "suite" is just the default here: follow the desktop.
pub fn theme() -> serde_json::Value {
    let v: serde_json::Value = file().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    serde_json::json!({ "suite": v["suite"].as_str().unwrap_or("desktop"), "own": v["own"].as_str() })
}

pub fn set_theme(own: bool, value: Option<&str>) -> Result<(), String> {
    if let Some(v) = value {
        if v.is_empty() || v.len() > 40 || !v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err(format!("not a theme name: {v}"));
        }
    }
    let f = file().ok_or("no config folder")?;
    let mut j: serde_json::Value = std::fs::read(&f).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if !j.is_object() {
        j = serde_json::json!({});
    }
    j[if own { "own" } else { "suite" }] = value.map(Into::into).unwrap_or(serde_json::Value::Null);
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&f, j.to_string()).map_err(|e| e.to_string())
}
