//! `inode --default on|off|status`: make Inode the default file manager on Omarchy (Hyprland), and undo it exactly.
//! Three per-user pieces: the desktop entry + mime default, D-Bus activation of FileManager1, the Hyprland key.
use serde::{Deserialize, Serialize};
use std::io::Result;
use std::path::{Path, PathBuf};
use std::process::Command;

const BEGIN: &str = "-- >>> inode default\n";
const END: &str = "-- <<< inode default\n";

/// The two per-user roots everything lives under, so tests can point them at a temp folder.
pub struct Dirs {
    pub data: PathBuf,
    pub config: PathBuf,
}

impl Dirs {
    fn from_env() -> Option<Dirs> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let dir = |var: &str, rest: &str| std::env::var_os(var).map(PathBuf::from).or_else(|| Some(home.as_ref()?.join(rest)));
        Some(Dirs { data: dir("XDG_DATA_HOME", ".local/share")?, config: dir("XDG_CONFIG_HOME", ".config")? })
    }
    fn desktop(&self) -> PathBuf {
        self.data.join("applications/inode.desktop")
    }
    fn service(&self) -> PathBuf {
        self.data.join("dbus-1/services/org.freedesktop.FileManager1.service")
    }
    fn bindings(&self) -> PathBuf {
        self.config.join("hypr/bindings.lua")
    }
    fn backup(&self) -> PathBuf {
        self.config.join("inode/default-backup.json")
    }
}

/// What was there before `on`, for `off` to put back. A file that did not exist is None.
#[derive(Serialize, Deserialize)]
struct Backup {
    mime: Option<String>,
    desktop: Option<String>,
    service: Option<String>,
}

/// The exe as one word in a shell command and in an Exec= line.
fn word(exe: &str) -> String {
    if exe.contains(' ') { format!("\"{exe}\"") } else { exe.into() }
}

fn desktop_text(exe: &str) -> String {
    format!("[Desktop Entry]\nType=Application\nName=Inode\nExec={} %U\nIcon=inode\nMimeType=inode/directory;\nCategories=System;FileManager;\nTerminal=false\n", word(exe))
}

fn service_text(exe: &str) -> String {
    format!("[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec={} --service\n", word(exe))
}

/// The text without our block: exactly what it was before `add_block`.
fn strip_block(text: &str) -> String {
    match (text.find(&format!("\n{BEGIN}")), text.find(END)) {
        (Some(a), Some(b)) if a < b => format!("{}{}", &text[..a], &text[b + END.len()..]),
        _ => text.into(),
    }
}

/// Appends the block that points the file-manager keys at Inode: Omarchy's default key (SUPER + SHIFT + F)
/// and any key this file itself binds as "File manager". Last bind wins, so the block goes at the end.
fn add_block(text: &str, exe: &str) -> String {
    let text = strip_block(text);
    let mut keys = vec!["SUPER + SHIFT + F"];
    for line in text.lines() {
        let l = line.trim_start();
        let Some(rest) = l.strip_prefix("o.bind(\"").or_else(|| l.strip_prefix("o.rebind(\"")) else { continue };
        match rest.split_once('"') {
            Some((key, after)) if after.starts_with(", \"File manager\"") && !keys.contains(&key) => keys.push(key),
            _ => {}
        }
    }
    let launch = word(exe).replace('"', "\\\""); // inside a Lua string
    let binds: String = keys.iter().map(|k| format!("o.rebind(\"{k}\", \"File manager\", {{ launch = \"{launch}\" }})\n")).collect();
    format!("{text}\n{BEGIN}{binds}{END}")
}

fn write(path: &Path, text: &str) -> Result<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, text)
}

/// Writes the three pieces; safe to repeat. Ok(false) = there is no bindings.lua, so no key was bound.
/// `mime_before` is the current default for inode/directory, kept for `off`.
pub fn on(d: &Dirs, exe: &str, mime_before: Option<String>) -> Result<bool> {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok();
    // Only the first `on` records what was there: a repeat would record Inode's own files as "before".
    if !d.backup().exists() {
        let before = Backup { mime: mime_before, desktop: read(d.desktop()), service: read(d.service()) };
        write(&d.backup(), &serde_json::to_string_pretty(&before)?)?;
    }
    write(&d.desktop(), &desktop_text(exe))?;
    write(&d.service(), &service_text(exe))?;
    match read(d.bindings()) {
        Some(text) => std::fs::write(d.bindings(), add_block(&text, exe)).map(|_| true),
        None => Ok(false),
    }
}

/// Puts everything back. None = `on` never ran; Some(mime) = done, and `mime` is the default to restore.
pub fn off(d: &Dirs) -> Result<Option<Option<String>>> {
    let Ok(json) = std::fs::read_to_string(d.backup()) else { return Ok(None) };
    let before: Backup = serde_json::from_str(&json)?;
    for (path, text) in [(d.desktop(), &before.desktop), (d.service(), &before.service)] {
        match text {
            Some(t) => write(&path, t)?,
            None => std::fs::remove_file(&path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })?,
        }
    }
    if let Ok(text) = std::fs::read_to_string(d.bindings()) {
        std::fs::write(d.bindings(), strip_block(&text))?;
    }
    std::fs::remove_file(d.backup())?;
    Ok(Some(before.mime))
}

/// Which pieces point at this exe now: [desktop entry + mime default, D-Bus service, Hyprland key].
pub fn status(d: &Dirs, exe: &str, mime: Option<&str>) -> [bool; 3] {
    let is = |p: PathBuf, want: String| std::fs::read_to_string(p).is_ok_and(|t| t == want);
    [
        mime == Some("inode.desktop") && is(d.desktop(), desktop_text(exe)),
        is(d.service(), service_text(exe)),
        std::fs::read_to_string(d.bindings()).is_ok_and(|t| t.contains(BEGIN)),
    ]
}

fn mime_default() -> Option<String> {
    let out = Command::new("xdg-mime").args(["query", "default", "inode/directory"]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

fn set_mime_default(desktop: &str) -> std::result::Result<(), String> {
    match Command::new("xdg-mime").args(["default", desktop, "inode/directory"]).status() {
        Ok(s) if s.success() => Ok(()),
        _ => Err(format!("xdg-mime could not make {desktop} the default for folders")),
    }
}

/// Handles `--default on|off|status`: Some(exit code) when the arguments ask for it, None to start the app.
pub fn cli(args: &[String]) -> Option<i32> {
    let i = args.iter().position(|a| a == "--default")?;
    let run = || -> std::result::Result<(), String> {
        let d = Dirs::from_env().ok_or("HOME is not set")?;
        // An AppImage runs from a temporary mount; APPIMAGE is the file the user actually has.
        let exe = std::env::var("APPIMAGE").ok().or_else(|| Some(std::env::current_exe().ok()?.to_str()?.to_string())).ok_or("cannot tell where inode is")?;
        if exe.contains(['"', '\\', '$', '`', '\n']) {
            return Err(format!("cannot use a program path with quotes, backslashes or $ in it: {exe}"));
        }
        match args.get(i + 1).map(String::as_str) {
            Some("on") => {
                let key = on(&d, &exe, mime_default()).map_err(|e| e.to_string())?;
                set_mime_default("inode.desktop")?;
                reload_dbus();
                println!("Inode is now the default file manager (inode --default off undoes it).");
                if !key {
                    println!("No {} here, so no key was bound.", d.bindings().display());
                }
            }
            Some("off") => match off(&d).map_err(|e| e.to_string())? {
                None => println!("Inode was not set as the default; nothing to undo."),
                Some(mime) => {
                    match mime {
                        Some(m) => set_mime_default(&m)?,
                        None => println!("Folders had no default app before; none is set now."),
                    }
                    reload_dbus();
                    println!("Inode is no longer the default file manager.");
                }
            },
            Some("status") => {
                let s = status(&d, &exe, mime_default().as_deref());
                for (name, on) in ["Opens folders (desktop entry + mime default)", "Show in folder (D-Bus FileManager1)", "File manager key (Hyprland)"].iter().zip(s) {
                    println!("{name}: {}", if on { "Inode" } else { "not Inode" });
                }
            }
            _ => return Err("usage: inode --default on|off|status".into()),
        }
        Ok(())
    };
    Some(match run() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("inode: {e}");
            1
        }
    })
}

/// The bus only notices a new or removed .service file when told to look again.
fn reload_dbus() {
    let _ = Command::new("busctl").args(["--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReloadConfig"]).output();
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/opt/inode/inode";

    fn dirs(tag: &str) -> Dirs {
        let root = std::env::temp_dir().join(format!("inode-setup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        Dirs { data: root.join("data"), config: root.join("config") }
    }

    #[test]
    fn on_then_off_restores_everything() {
        // No newline at the end on purpose: the block must come off without leaving one behind.
        let lua = "o.rebind(\"SUPER + E\", \"File manager\", { launch = \"omanta\" })\no.bind(\"SUPER + Z\", \"Terminal\", \"x\")\nend";
        let d = dirs("roundtrip");
        write(&d.bindings(), lua).unwrap();
        write(&d.service(), "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=other\n").unwrap();

        assert!(on(&d, EXE, Some("other.desktop".into())).unwrap());
        assert!(on(&d, EXE, Some("inode.desktop".into())).unwrap()); // a repeat changes nothing
        assert_eq!(status(&d, EXE, Some("inode.desktop")), [true, true, true]);
        let now = std::fs::read_to_string(d.bindings()).unwrap();
        assert_eq!(now.matches(BEGIN).count(), 1);
        assert_eq!(
            &now[lua.len()..],
            "\n-- >>> inode default\no.rebind(\"SUPER + SHIFT + F\", \"File manager\", { launch = \"/opt/inode/inode\" })\no.rebind(\"SUPER + E\", \"File manager\", { launch = \"/opt/inode/inode\" })\n-- <<< inode default\n"
        );
        assert!(std::fs::read_to_string(d.desktop()).unwrap().contains("Exec=/opt/inode/inode %U\n"));
        assert!(std::fs::read_to_string(d.service()).unwrap().ends_with("Exec=/opt/inode/inode --service\n"));

        assert_eq!(off(&d).unwrap(), Some(Some("other.desktop".into())));
        assert_eq!(std::fs::read_to_string(d.bindings()).unwrap(), lua);
        assert_eq!(std::fs::read_to_string(d.service()).unwrap(), "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=other\n");
        assert!(!d.desktop().exists() && !d.backup().exists());
        assert_eq!(status(&d, EXE, Some("other.desktop")), [false, false, false]);
        assert_eq!(off(&d).unwrap(), None);
    }

    #[test]
    fn works_with_nothing_there_before() {
        let d = dirs("fresh");
        assert!(!on(&d, "/my apps/inode", None).unwrap()); // no bindings.lua: skipped, not created
        assert!(!d.bindings().exists());
        assert!(std::fs::read_to_string(d.service()).unwrap().ends_with("Exec=\"/my apps/inode\" --service\n"));
        assert_eq!(off(&d).unwrap(), Some(None));
        assert!(!d.desktop().exists() && !d.service().exists());
    }
}
