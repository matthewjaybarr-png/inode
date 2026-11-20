//! `inode --default on|off|status`: make Inode the default file manager on Omarchy (Hyprland), and undo it exactly.
//! Three per-user pieces: the desktop entry + mime default, D-Bus activation of FileManager1, the Hyprland key.
//! `inode --picker on|off|status`: make Inode the file chooser other apps' Open and Save dialogs use (portal.rs),
//! and undo it exactly. Also three per-user pieces: the portal file, D-Bus activation of the portal name, and the
//! FileChooser line of the user's portals.conf. Both are opt-in; nothing here runs unless asked for.
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
    fn portal(&self) -> PathBuf {
        self.data.join("xdg-desktop-portal/portals/inode.portal")
    }
    fn portal_service(&self) -> PathBuf {
        self.data.join(format!("dbus-1/services/{PORTAL}.service"))
    }
    fn portals_conf(&self, name: &str) -> PathBuf {
        self.config.join("xdg-desktop-portal").join(name)
    }
}

/// What was there before `on`, for `off` to put back. A file that did not exist is None.
/// One file for both switches; it is deleted when neither is on.
#[derive(Serialize, Deserialize)]
struct Backup {
    /// `--default` is on. Files written before `--picker` existed have no such key, and they only existed while it was on.
    #[serde(default = "yes")]
    set: bool,
    mime: Option<String>,
    desktop: Option<String>,
    service: Option<String>,
    /// `--picker` is on, and what was there before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    picker: Option<PickerBackup>,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
struct PickerBackup {
    portal: Option<String>,
    service: Option<String>,
    /// The portals.conf that was edited (its file name), whether `on` had to create it, and its FileChooser line before.
    conf: String,
    created: bool,
    line: Option<String>,
}

/// The backup file; none = neither switch is on.
fn load(d: &Dirs) -> Result<Backup> {
    match std::fs::read_to_string(d.backup()) {
        Ok(json) => Ok(serde_json::from_str(&json)?),
        Err(_) => Ok(Backup { set: false, mime: None, desktop: None, service: None, picker: None }),
    }
}

fn save(d: &Dirs, b: &Backup) -> Result<()> {
    if b.set || b.picker.is_some() { write(&d.backup(), &serde_json::to_string_pretty(b)?) } else { put_back(&d.backup(), &None) }
}

/// A file as it was before: its old text, or gone again.
fn put_back(path: &Path, text: &Option<String>) -> Result<()> {
    match text {
        Some(t) => write(path, t),
        None => std::fs::remove_file(path).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
    }
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
    let b = load(d)?;
    if !b.set {
        save(d, &Backup { set: true, mime: mime_before, desktop: read(d.desktop()), service: read(d.service()), picker: b.picker })?;
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
    let before = load(d)?;
    if !before.set {
        return Ok(None);
    }
    put_back(&d.desktop(), &before.desktop)?;
    put_back(&d.service(), &before.service)?;
    if let Ok(text) = std::fs::read_to_string(d.bindings()) {
        std::fs::write(d.bindings(), strip_block(&text))?;
    }
    save(d, &Backup { set: false, mime: None, desktop: None, service: None, picker: before.picker })?;
    Ok(Some(before.mime))
}

const PORTAL: &str = "org.freedesktop.impl.portal.desktop.inode";
const CHOOSER: &str = "org.freedesktop.impl.portal.FileChooser";
const PORTAL_TEXT: &str = "[portal]\nDBusName=org.freedesktop.impl.portal.desktop.inode\nInterfaces=org.freedesktop.impl.portal.FileChooser;\n";

fn portal_service_text(exe: &str) -> String {
    format!("[D-BUS Service]\nName={PORTAL}\nExec={} --service\n", word(exe))
}

/// Where `key` is set in the [preferred] section of a portals.conf: (index of that line, index just after the
/// section's last line), counting lines as split_inclusive('\n') gives them.
fn pref(text: &str, key: &str) -> (Option<usize>, Option<usize>) {
    let (mut inside, mut at, mut end) = (false, None, None);
    for (i, l) in text.split_inclusive('\n').enumerate() {
        let l = l.trim();
        if l.starts_with('[') {
            inside = l == "[preferred]";
        }
        if inside && !l.is_empty() {
            end = Some(i + 1);
            if l.split('=').next().map(str::trim) == Some(key) {
                at = Some(i);
            }
        }
    }
    (at, end)
}

/// That line, without its line end.
fn pref_line<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.split_inclusive('\n').nth(pref(text, key).0?).map(|l| l.trim_end_matches(['\n', '\r']))
}

/// The portals.conf text with the FileChooser line of [preferred] set to `line` (None = no such line).
/// Every other byte stays, so putting the old line back gives the old text back.
fn set_chooser(text: &str, line: Option<&str>) -> String {
    let mut lines: Vec<String> = text.split_inclusive('\n').map(String::from).collect();
    match (pref(text, CHOOSER), line) {
        ((Some(i), _), Some(new)) => lines[i] = format!("{new}{}", &lines[i][lines[i].trim_end_matches(['\n', '\r']).len()..]),
        ((Some(i), _), None) => {
            let gone = lines.remove(i);
            // The last line, with no line end: then adding it also ended the line before (see the next arm).
            if !gone.ends_with('\n') && i > 0 && i == lines.len() {
                lines[i - 1].pop();
            }
        }
        ((None, Some(end)), Some(new)) => {
            if lines[end - 1].ends_with('\n') {
                lines.insert(end, format!("{new}\n"));
            } else {
                lines[end - 1].push('\n');
                lines.insert(end, new.to_string());
            }
        }
        // shortcut: a file with no [preferred] section gets one, and `off` leaves the empty section behind
        // (it means nothing to xdg-desktop-portal). Remember the whole old text if that is ever not good enough.
        ((None, None), Some(new)) => lines.push(format!("{}[preferred]\n{new}\n", if text.is_empty() || text.ends_with('\n') { "" } else { "\n" })),
        ((None, _), None) => {}
    }
    lines.concat()
}

/// Which portals.conf xdg-desktop-portal reads for this user, by its own rule: the first that exists of
/// "<desktop>-portals.conf" for each name in XDG_CURRENT_DESKTOP (lower case), then "portals.conf".
/// None exists: the first of those names (the file is then started from the system's copy, see `picker_on`).
fn conf_name(desktops: &str, exists: impl Fn(&str) -> bool) -> String {
    let mut names: Vec<String> = desktops.split(':').filter(|d| !d.is_empty()).map(|d| format!("{}-portals.conf", d.to_lowercase())).collect();
    names.push("portals.conf".into());
    names.iter().find(|n| exists(n)).unwrap_or(&names[0]).clone()
}

/// Makes Inode the file chooser; safe to repeat. `conf` is the user's portals.conf to edit (see `conf_name`) and
/// `seed` the system's copy of it, used when the user has none yet: a user file replaces the system one whole.
/// Inode goes first in the list and what was there stays behind it, so dialogs still open if Inode cannot start.
pub fn picker_on(d: &Dirs, exe: &str, conf: &str, seed: Option<String>) -> Result<()> {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok();
    let mut b = load(d)?;
    // A repeat edits the file the first `on` chose, and does not record Inode's own pieces as "before".
    let conf = b.picker.as_ref().map_or(conf, |p| p.conf.as_str()).to_string();
    let now = read(d.portals_conf(&conf));
    if b.picker.is_none() {
        b.picker = Some(PickerBackup { portal: read(d.portal()), service: read(d.portal_service()), conf: conf.clone(), created: now.is_none(), line: now.as_deref().and_then(|t| pref_line(t, CHOOSER)).map(String::from) });
        save(d, &b)?;
    }
    write(&d.portal(), PORTAL_TEXT)?;
    write(&d.portal_service(), &portal_service_text(exe))?;
    let text = now.or(seed).unwrap_or_else(|| "[preferred]\ndefault=*\n".into());
    let value = |key: &str| pref_line(&text, key).and_then(|l| l.split_once('=')).map(|(_, v)| v.trim().to_string());
    let before = value(CHOOSER).or_else(|| value("default")).unwrap_or_default();
    let list: Vec<&str> = std::iter::once("inode").chain(before.split(';').map(str::trim).filter(|v| !v.is_empty() && *v != "inode")).collect();
    write(&d.portals_conf(&conf), &set_chooser(&text, Some(&format!("{CHOOSER}={}", list.join(";")))))
}

/// Puts the three pieces back. false = `picker_on` never ran.
pub fn picker_off(d: &Dirs) -> Result<bool> {
    let mut b = load(d)?;
    let Some(p) = b.picker.take() else { return Ok(false) };
    put_back(&d.portal(), &p.portal)?;
    put_back(&d.portal_service(), &p.service)?;
    let conf = d.portals_conf(&p.conf);
    if p.created {
        put_back(&conf, &None)?;
    } else if let Ok(text) = std::fs::read_to_string(&conf) {
        std::fs::write(&conf, set_chooser(&text, p.line.as_deref()))?;
    }
    save(d, &b)?;
    Ok(true)
}

/// Which pieces point at this exe now: [portal file, D-Bus service, Inode first in the FileChooser line of `conf`].
pub fn picker_status(d: &Dirs, exe: &str, conf: &str) -> [bool; 3] {
    let is = |p: PathBuf, want: &str| std::fs::read_to_string(p).is_ok_and(|t| t == want);
    let first = std::fs::read_to_string(d.portals_conf(conf)).ok().and_then(|t| Some(pref_line(&t, CHOOSER)?.split_once('=')?.1.split(';').next()?.trim() == "inode"));
    [is(d.portal(), PORTAL_TEXT), is(d.portal_service(), &portal_service_text(exe)), first == Some(true)]
}

/// `--picker on|off|status`. Nothing is restarted: the running xdg-desktop-portal keeps its old choice until the next login.
fn picker_cli(d: &Dirs, exe: &str, arg: Option<&str>) -> std::result::Result<(), String> {
    let desktops = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let conf = conf_name(&desktops, |n| d.portals_conf(n).exists());
    match arg {
        Some("on") => {
            // The system's copy of that file, in the order xdg-desktop-portal looks.
            let seed = ["/etc/xdg/xdg-desktop-portal", "/etc/xdg-desktop-portal", "/usr/local/share/xdg-desktop-portal", "/usr/share/xdg-desktop-portal"]
                .iter()
                .flat_map(|dir| [Path::new(dir).join(&conf), Path::new(dir).join("portals.conf")])
                .find_map(|p| std::fs::read_to_string(p).ok());
            picker_on(d, exe, &conf, seed).map_err(|e| e.to_string())?;
            reload_dbus();
            println!("Inode is now the file chooser for other apps' Open and Save dialogs (inode --picker off undoes it).");
            println!("It takes effect after you log out and back in, or restart xdg-desktop-portal yourself:");
            println!("  systemctl --user restart xdg-desktop-portal");
            println!("The chooser's window title starts with \"Inode: \", for a window rule that floats it.");
        }
        Some("off") => {
            if picker_off(d).map_err(|e| e.to_string())? {
                reload_dbus();
                println!("Inode is no longer the file chooser; what was set before is back.");
                println!("It takes effect after you log out and back in, or restart xdg-desktop-portal yourself.");
            } else {
                println!("Inode was not set as the file chooser; nothing to undo.");
            }
        }
        Some("status") => {
            let s = picker_status(d, exe, &conf);
            let names = ["Portal file (inode.portal)".to_string(), "D-Bus service (starts Inode for a dialog)".to_string(), format!("First file chooser in {}", d.portals_conf(&conf).display())];
            for (name, on) in names.iter().zip(s) {
                println!("{name}: {}", if on { "Inode" } else { "not Inode" });
            }
        }
        _ => return Err("usage: inode --picker on|off|status".into()),
    }
    Ok(())
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

/// Handles `--default on|off|status` and `--picker on|off|status`: Some(exit code) when the arguments ask for one, None to start the app.
pub fn cli(args: &[String]) -> Option<i32> {
    let i = args.iter().position(|a| a == "--default" || a == "--picker")?;
    let run = || -> std::result::Result<(), String> {
        let d = Dirs::from_env().ok_or("HOME is not set")?;
        // An AppImage runs from a temporary mount; APPIMAGE is the file the user actually has.
        let exe = std::env::var("APPIMAGE").ok().or_else(|| Some(std::env::current_exe().ok()?.to_str()?.to_string())).ok_or("cannot tell where inode is")?;
        if exe.contains(['"', '\\', '$', '`', '\n']) {
            return Err(format!("cannot use a program path with quotes, backslashes or $ in it: {exe}"));
        }
        if args[i] == "--picker" {
            return picker_cli(&d, &exe, args.get(i + 1).map(String::as_str));
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

    const CONF: &str = "hyprland-portals.conf";

    #[test]
    fn picker_on_then_off_restores_everything() {
        let d = dirs("picker");
        let conf = "[preferred]\ndefault=hyprland;gtk\norg.freedesktop.impl.portal.Secret=gnome-keyring\norg.freedesktop.impl.portal.FileChooser=omanta;gtk\n";
        write(&d.portals_conf(CONF), conf).unwrap();
        write(&d.portal_service(), "someone else's").unwrap();

        picker_on(&d, EXE, CONF, None).unwrap();
        picker_on(&d, EXE, "portals.conf", None).unwrap(); // a repeat changes nothing, and stays with the first file
        assert_eq!(picker_status(&d, EXE, CONF), [true, true, true]);
        assert_eq!(std::fs::read_to_string(d.portals_conf(CONF)).unwrap(), conf.replace("FileChooser=omanta;gtk", "FileChooser=inode;omanta;gtk"));
        assert!(!d.portals_conf("portals.conf").exists());
        assert_eq!(std::fs::read_to_string(d.portal()).unwrap(), "[portal]\nDBusName=org.freedesktop.impl.portal.desktop.inode\nInterfaces=org.freedesktop.impl.portal.FileChooser;\n");
        assert_eq!(std::fs::read_to_string(d.portal_service()).unwrap(), "[D-BUS Service]\nName=org.freedesktop.impl.portal.desktop.inode\nExec=/opt/inode/inode --service\n");

        assert!(picker_off(&d).unwrap());
        assert_eq!(std::fs::read_to_string(d.portals_conf(CONF)).unwrap(), conf);
        assert_eq!(std::fs::read_to_string(d.portal_service()).unwrap(), "someone else's");
        assert!(!d.portal().exists() && !d.backup().exists());
        assert_eq!(picker_status(&d, EXE, CONF), [false, false, false]);
        assert!(!picker_off(&d).unwrap());
    }

    #[test]
    fn picker_and_default_are_switched_separately() {
        let d = dirs("both");
        // A backup written before --picker existed: no "set" key, and --default is on.
        write(&d.backup(), "{\"mime\":\"other.desktop\",\"desktop\":null,\"service\":null}").unwrap();
        // No portals.conf of the user's yet: the system's copy is the start, with its default list as the fallback.
        picker_on(&d, EXE, CONF, Some("[preferred]\ndefault=hyprland;gtk\n".into())).unwrap();
        assert_eq!(std::fs::read_to_string(d.portals_conf(CONF)).unwrap(), "[preferred]\ndefault=hyprland;gtk\norg.freedesktop.impl.portal.FileChooser=inode;hyprland;gtk\n");
        assert_eq!(off(&d).unwrap(), Some(Some("other.desktop".into())));
        assert!(d.backup().exists()); // the picker's half is still needed
        assert_eq!(off(&d).unwrap(), None);
        assert!(on(&d, EXE, None).is_ok() && picker_status(&d, EXE, CONF) == [true, true, true]);
        assert!(picker_off(&d).unwrap());
        assert!(!d.portals_conf(CONF).exists() && !d.portal().exists() && !d.portal_service().exists());
        assert_eq!(off(&d).unwrap(), Some(None));
        assert!(!d.backup().exists());
    }

    #[test]
    fn the_chooser_line_is_set_and_taken_back_byte_for_byte() {
        let line = "org.freedesktop.impl.portal.FileChooser=inode";
        for text in ["[preferred]\ndefault=gtk\n", "[preferred]\ndefault=gtk", "# mine\n[preferred]\ndefault=gtk\n\n[other]\nx=1\n", "[preferred]\r\ndefault=gtk\r\n"] {
            let with = set_chooser(text, Some(line));
            assert_eq!(pref_line(&with, CHOOSER), Some(line), "{text:?}");
            assert_eq!(set_chooser(&with, None), text, "{text:?}");
        }
        assert_eq!(set_chooser("[preferred]\ndefault=gtk\n\n[other]\nx=1\n", Some(line)), format!("[preferred]\ndefault=gtk\n{line}\n\n[other]\nx=1\n"));
        // An existing line keeps its place and its line end; one in another section is not ours.
        let old = "[preferred]\n org.freedesktop.impl.portal.FileChooser = kde\r\ndefault=gtk\n";
        assert_eq!(set_chooser(&set_chooser(old, Some(line)), pref_line(old, CHOOSER)), old);
        assert_eq!(pref_line("[other]\norg.freedesktop.impl.portal.FileChooser=x\n", CHOOSER), None);
        assert_eq!(set_chooser("", Some(line)), format!("[preferred]\n{line}\n"));
        assert_eq!(set_chooser("x=1", None), "x=1");
    }

    #[test]
    fn the_portals_conf_is_chosen_like_xdg_desktop_portal_does() {
        assert_eq!(conf_name("Hyprland", |n| n == "hyprland-portals.conf" || n == "portals.conf"), "hyprland-portals.conf");
        assert_eq!(conf_name("Hyprland", |n| n == "portals.conf"), "portals.conf");
        assert_eq!(conf_name("ubuntu:GNOME", |n| n == "gnome-portals.conf"), "gnome-portals.conf");
        assert_eq!(conf_name("Hyprland", |_| false), "hyprland-portals.conf");
        assert_eq!(conf_name("", |_| false), "portals.conf");
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
