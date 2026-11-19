//! Reading folders and the places sidebar. All paths cross the IPC boundary as plain strings.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

type R<T> = Result<T, String>;

#[derive(Serialize, Debug)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    /// Modified time, ms since 1970 (0 when unknown).
    pub mtime: f64,
    pub hidden: bool,
    pub link: bool,
}

#[derive(Serialize, Debug)]
pub struct Listing {
    /// The folder as listed ("" = the drives list on Windows).
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn is_hidden(name: &str, md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    name.starts_with('.') || md.file_attributes() & 0x2 != 0
}
#[cfg(not(windows))]
fn is_hidden(name: &str, _: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

/// Windows drive letters, including mapped network drives (H:, U:, ...). GetLogicalDrives touches no
/// disk or network, so a disconnected mapped drive is still listed (and marked offline by the UI's probe).
#[cfg(windows)]
pub fn drives() -> Vec<String> {
    let mask = unsafe { win::GetLogicalDrives() };
    (0..26u8).filter(|i| mask & (1 << i) != 0).map(|i| format!("{}:\\", (b'A' + i) as char)).collect()
}

#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetLogicalDrives() -> u32;
        pub fn GetDriveTypeW(root: *const u16) -> u32;
        pub fn GetVolumeInformationW(root: *const u16, name: *mut u16, len: u32, serial: *mut u32, max: *mut u32, flags: *mut u32, fs: *mut u16, fs_len: u32) -> i32;
    }
    #[link(name = "mpr")]
    extern "system" {
        pub fn WNetGetConnectionW(local: *const u16, remote: *mut u16, len: *mut u32) -> u32;
    }
    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub fn text(b: &[u16]) -> String {
        String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())])
    }
}

/// "H:  Tooling" for a drive: the share name of a mapped drive (read from the mapping, no network
/// I/O), else the volume label. CD drives are skipped so a label never spins one up.
#[cfg(windows)]
fn drive_name(d: &str) -> (String, String) {
    let letter = d.trim_end_matches('\\');
    let (mut label, mut title) = (String::new(), d.to_string());
    unsafe {
        match win::GetDriveTypeW(win::wide(d).as_ptr()) {
            4 => {
                let mut buf = [0u16; 512];
                let mut len = buf.len() as u32;
                if win::WNetGetConnectionW(win::wide(letter).as_ptr(), buf.as_mut_ptr(), &mut len) == 0 {
                    title = win::text(&buf);
                    label = title.trim_end_matches('\\').rsplit('\\').next().unwrap_or("").to_string();
                }
            }
            2 | 3 => {
                let mut buf = [0u16; 261];
                if win::GetVolumeInformationW(win::wide(d).as_ptr(), buf.as_mut_ptr(), buf.len() as u32, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0) != 0 {
                    label = win::text(&buf);
                }
            }
            _ => {}
        }
    }
    (if label.is_empty() { letter.to_string() } else { format!("{letter}  {label}") }, title)
}
#[cfg(not(windows))]
fn drive_name(d: &str) -> (String, String) {
    let name = if d == "/" { "File System".to_string() } else { Path::new(d).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(d.to_string()) };
    (name, d.to_string())
}

/// "dir" when the folder can be read, "file" for a file, "" when neither answers within 3 s. A dead network
/// share can block for much longer, so the check runs on its own thread and is abandoned on timeout.
pub fn reachable(path: String) -> &'static str {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let kind = match std::fs::metadata(&path) {
            Ok(m) if m.is_dir() => if std::fs::read_dir(&path).is_ok() { "dir" } else { "" },
            Ok(_) => "file",
            Err(_) => "",
        };
        let _ = tx.send(kind);
    });
    rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap_or("")
}
#[cfg(not(windows))]
pub fn drives() -> Vec<String> {
    // Removable and extra disks: whatever is mounted under the usual mount roots.
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    let mut v: Vec<String> = mounts
        .lines()
        .filter_map(|l| l.split(' ').nth(1))
        .map(|m| m.replace("\\040", " "))
        .filter(|m| m.starts_with("/run/media/") || m.starts_with("/media/") || m.starts_with("/mnt/"))
        .collect();
    v.dedup();
    v.insert(0, "/".into());
    v
}

/// One folder entry, plus whether it is a real folder to descend into (links are not, so a search cannot loop).
fn entry(de: &std::fs::DirEntry) -> Option<(Entry, bool)> {
    let name = de.file_name().to_string_lossy().into_owned();
    let lmd = de.metadata().ok()?;
    let link = lmd.file_type().is_symlink();
    let real_dir = lmd.is_dir() && !link;
    // The link's own attributes decide hidden: Windows junctions (Application Data, NetHood) are hidden, their targets are not.
    let hidden = is_hidden(&name, &lmd);
    // Follow links so a link to a folder opens like a folder; a broken link stays a plain entry.
    let md = if link { std::fs::metadata(de.path()).unwrap_or(lmd) } else { lmd };
    let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    Some((Entry { hidden, path: s(&de.path()), name, dir: md.is_dir(), size: if md.is_dir() { 0 } else { md.len() }, mtime, link }, real_dir))
}

#[derive(Serialize, Debug)]
pub struct Found {
    pub entries: Vec<Entry>,
    /// Stopped at the limit; there may be more.
    pub truncated: bool,
}

static SEARCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Names under `root` containing `query` (any case), nearest folders first. A newer search stops this one.
/// Hidden folders are only entered when `hidden` is on, so .git and AppData do not drown the results.
pub fn search(root: &str, query: &str, hidden: bool, limit: usize) -> R<Found> {
    use std::sync::atomic::Ordering::SeqCst;
    let gen = SEARCH_GEN.fetch_add(1, SeqCst) + 1;
    let q = query.to_lowercase();
    let mut found = Found { entries: Vec::new(), truncated: false };
    if q.is_empty() {
        return Ok(found);
    }
    std::fs::read_dir(root).map_err(|e| format!("Cannot open {root}: {e}"))?;
    let mut todo = std::collections::VecDeque::from([PathBuf::from(root)]);
    while let Some(dir) = todo.pop_front() {
        if SEARCH_GEN.load(SeqCst) != gen {
            return Err("superseded".into());
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for de in rd.flatten() {
            let Some((e, real_dir)) = entry(&de) else { continue };
            if real_dir && (hidden || !e.hidden) {
                todo.push_back(de.path());
            }
            if (hidden || !e.hidden) && e.name.to_lowercase().contains(&q) {
                if found.entries.len() == limit {
                    found.truncated = true;
                    return Ok(found);
                }
                found.entries.push(e);
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod search_tests {
    #[test]
    fn finds_nested_skips_hidden_dirs_and_caps() {
        let root = std::env::temp_dir().join(format!("inode-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        for f in ["Report.txt", "a/b/report-2.pdf", ".git/report-3", "a/other.txt"] {
            std::fs::write(root.join(f), "").unwrap();
        }
        let r = root.to_string_lossy();
        let names = |f: super::Found| f.entries.into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names(super::search(&r, "REPORT", false, 50).unwrap()), ["Report.txt", "report-2.pdf"]);
        assert_eq!(super::search(&r, "report", true, 50).unwrap().entries.len(), 3);
        let capped = super::search(&r, "report", true, 1).unwrap();
        assert!(capped.truncated && capped.entries.len() == 1);
        std::fs::remove_dir_all(&root).unwrap();
    }
}

/// Lists one folder. Unreadable entries are skipped rather than failing the whole folder.
pub fn list(path: &str) -> R<Listing> {
    if path.is_empty() && cfg!(windows) {
        let entries = drives()
            .into_iter()
            .map(|d| Entry { name: d.clone(), path: d, dir: true, size: 0, mtime: 0.0, hidden: false, link: false })
            .collect();
        return Ok(Listing { path: String::new(), parent: None, entries });
    }
    let dir = PathBuf::from(path);
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let mut entries = Vec::new();
    for de in rd.flatten() {
        if let Some((e, _)) = entry(&de) {
            entries.push(e);
        }
    }
    let parent = match dir.parent() {
        Some(p) => Some(s(p)),
        // A drive root's parent is the drives list.
        None if cfg!(windows) => Some(String::new()),
        None => None,
    };
    Ok(Listing { path: s(&dir), parent, entries })
}

#[derive(Serialize)]
pub struct Place {
    pub name: String,
    /// Tooltip: the full path, or a mapped drive's \\server\share.
    pub title: String,
    pub path: String,
    pub kind: &'static str,
    /// A removable drive: the sidebar shows an eject button.
    pub eject: bool,
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Home, the usual user folders that exist, then drives.
pub fn places() -> Vec<Place> {
    let mut v = Vec::new();
    if let Some(h) = home() {
        v.push(Place { name: "Home".into(), title: s(&h), path: s(&h), kind: "home", eject: false });
        for (n, k) in [("Desktop", "desktop"), ("Documents", "documents"), ("Downloads", "downloads"), ("Pictures", "pictures"), ("Music", "music"), ("Videos", "videos")] {
            let p = h.join(n);
            if p.is_dir() {
                v.push(Place { name: n.into(), title: s(&p), path: s(&p), kind: k, eject: false });
            }
        }
    }
    if cfg!(windows) {
        v.push(Place { name: "This PC".into(), title: "This PC".into(), path: String::new(), kind: "computer", eject: false });
    }
    for d in drives() {
        let (name, title) = drive_name(&d);
        let eject = removable(&d);
        v.push(Place { name, title, path: d, kind: "drive", eject });
    }
    v
}

const IN_USE: &str = "it is still in use. Close anything open on it and try again.";

/// Only drives Windows calls removable: Explorer's Eject verb, which eject() uses, does not exist for
/// fixed-type USB disks. shortcut: USB hard drives get no button; upgrade to CM_Request_Device_EjectW if wanted.
#[cfg(windows)]
fn removable(d: &str) -> bool {
    unsafe { win::GetDriveTypeW(win::wide(d).as_ptr()) == 2 } // DRIVE_REMOVABLE
}

// udisks mounts plugged-in drives under /run/media (or /media); /mnt is fixed disks from fstab.
#[cfg(not(windows))]
fn removable(d: &str) -> bool {
    d.starts_with("/run/media/") || d.starts_with("/media/")
}

/// Unmounts a removable drive so it can be pulled out, then powers it off. udisks needs no root.
#[cfg(not(windows))]
pub fn eject(path: &str) -> R<()> {
    let mounts = std::fs::read_to_string("/proc/mounts").map_err(|e| e.to_string())?;
    let dev = mounts
        .lines()
        .find_map(|l| {
            let mut f = l.split(' ');
            let dev = f.next()?;
            (f.next()?.replace("\\040", " ") == path).then(|| dev.to_string())
        })
        .ok_or_else(|| format!("{path} is not mounted"))?;
    let run = |args: &[&str]| -> R<()> {
        let o = clean(std::process::Command::new("udisksctl")).args(args).output().map_err(|e| format!("udisksctl: {e}"))?;
        let err = String::from_utf8_lossy(&o.stderr);
        // udisks wraps the reason in D-Bus names; keep only the human part.
        if o.status.success() { Ok(()) } else if err.contains("DeviceBusy") { Err(IN_USE.into()) } else { Err(err.trim().rsplit(": ").next().unwrap_or("").to_string()) }
    };
    run(&["unmount", "--no-user-interaction", "-b", &dev])?;
    // Card readers and some hubs refuse power-off; once unmounted the drive is already safe to pull.
    let _ = run(&["power-off", "--no-user-interaction", "-b", &dev]);
    Ok(())
}

/// Explorer's own Eject verb (works for a standard user), then waits for the drive letter to go.
#[cfg(windows)]
pub fn eject(path: &str) -> R<()> {
    use std::os::windows::process::CommandExt;
    let b = path.as_bytes();
    // The letter goes into a script, so accept exactly "X:\\" and nothing else.
    if !(b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\') {
        return Err(format!("Not a drive: {path}"));
    }
    let script = format!(
        "$d='{path}'; (New-Object -ComObject Shell.Application).Namespace(17).ParseName($d).InvokeVerb('Eject'); \
         for($i=0; $i -lt 80 -and (Test-Path $d); $i++){{ Start-Sleep -Milliseconds 100 }}; if(Test-Path $d){{ exit 1 }}"
    );
    let ok = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status()
        .map_err(|e| e.to_string())?
        .success();
    if ok { Ok(()) } else { Err(IN_USE.into()) }
}

pub fn home_path() -> String {
    home().map(|h| s(&h)).unwrap_or_else(|| if cfg!(windows) { String::new() } else { "/".into() })
}

/// Opens a file or folder in the desktop's default app (the user double-clicked it, so programs run too).
pub fn open(path: &str) -> R<()> {
    if !Path::new(path).exists() {
        return Err(format!("Not found: {path}"));
    }
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(path);
        c
    } else {
        let mut c = clean(std::process::Command::new("xdg-open"));
        c.arg(path);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// An AppImage's private library paths must not leak into the apps it starts.
fn clean(mut c: std::process::Command) -> std::process::Command {
    for v in ["LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GDK_PIXBUF_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "PYTHONHOME", "PYTHONPATH", "PERLLIB", "QT_PLUGIN_PATH"] {
        c.env_remove(v);
    }
    c
}

/// A terminal in `dir`: Windows Terminal, else PowerShell; on Linux xdg-terminal-exec, else $TERMINAL.
pub fn open_terminal(dir: &str) -> R<()> {
    if !Path::new(dir).is_dir() {
        return Err(format!("Not a folder: {dir}"));
    }
    let tries: Vec<(String, Vec<String>)> = if cfg!(windows) {
        vec![
            ("wt.exe".into(), vec!["-d".into(), dir.into()]),
            // `start` gives PowerShell its own console window; cmd itself stays hidden.
            ("cmd.exe".into(), vec!["/c".into(), "start".into(), "".into(), "powershell.exe".into()]),
        ]
    } else {
        // The shell cds itself: single-instance terminals (Ghostty) ignore both the cwd and --dir.
        let cd = ["sh", "-c", r#"cd "$1" && exec "${SHELL:-sh}""#, "sh", dir].map(String::from).to_vec();
        let mut t = vec![("xdg-terminal-exec".to_string(), cd)];
        if let Ok(term) = std::env::var("TERMINAL") {
            t.push((term, vec![]));
        }
        t
    };
    let mut last = String::from("no terminal found");
    for (prog, args) in tries {
        let mut c = clean(std::process::Command::new(&prog));
        c.args(&args).current_dir(dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match c.spawn() {
            Ok(_) => return Ok(()),
            Err(e) => last = format!("{prog}: {e}"),
        }
    }
    Err(last)
}

#[derive(Serialize, Debug, Default)]
pub struct Props {
    pub size: u64,
    pub files: u64,
    pub folders: u64,
    /// Modified and created, ms since 1970 (0 when the file system does not say).
    pub mtime: f64,
    pub ctime: f64,
    /// Unix permission bits; None on Windows.
    pub mode: Option<u32>,
}

/// Size and dates for the Properties dialog; a folder's size is its whole tree (links are not followed).
pub fn props(path: &str) -> R<Props> {
    let md = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    let ms = |t: std::io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    let mut p = Props { size: md.len(), mtime: ms(md.modified()), ctime: ms(md.created()), ..Default::default() };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.mode = Some(md.permissions().mode() & 0o7777);
    }
    if md.is_dir() {
        p.size = 0;
        let mut stack = vec![PathBuf::from(path)];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let Ok(m) = e.metadata() else { continue };
                if m.is_dir() {
                    p.folders += 1;
                    stack.push(e.path());
                } else {
                    p.files += 1;
                    p.size += m.len();
                }
            }
        }
    }
    Ok(p)
}

#[derive(Serialize, Debug)]
pub struct App {
    /// Full path of the .desktop file (Linux).
    pub id: String,
    pub name: String,
    /// Says it handles this file's type.
    pub fit: bool,
    pub default: bool,
}

/// Apps for Open With: the desktop default first, then the ones whose MimeType fits, then every other app.
/// Windows returns none: the UI then shows the system's own Open With dialog.
#[cfg(windows)]
pub fn apps_for(_path: &str) -> Vec<App> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn apps_for(path: &str) -> Vec<App> {
    let ask = |args: &[&str]| clean(std::process::Command::new("xdg-mime")).args(args).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let mime = ask(&["query", "filetype", path]);
    let default = if mime.is_empty() { String::new() } else { ask(&["query", "default", &mime]) };
    let mut dirs = vec![std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".local/share"))).unwrap_or_default()];
    dirs.extend(std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into()).split(':').map(PathBuf::from));
    let mut seen = std::collections::HashSet::new();
    let mut apps = Vec::new();
    for dir in dirs.iter().map(|d| d.join("applications")) {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let file = e.file_name().to_string_lossy().into_owned();
            // The first data dir holding an id wins (a user's own copy overrides the system one).
            if !file.ends_with(".desktop") || !seen.insert(file.clone()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            if let Some(a) = desktop_app(&text, &mime) {
                let default = file == default;
                apps.push(App { id: s(&e.path()), name: a.0, fit: a.1 || default, default });
            }
        }
    }
    apps.sort_by_key(|a| (!a.default, !a.fit, a.name.to_lowercase()));
    apps
}

/// (Name, handles `mime`) for a launchable application entry; None for hidden ones and non-apps.
#[cfg(not(windows))]
fn desktop_app(text: &str, mime: &str) -> Option<(String, bool)> {
    let (mut name, mut types, mut nodisplay, mut app) = (None, "", false, false);
    let mut in_entry = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        let Some((k, v)) = line.split_once('=').filter(|_| in_entry) else { continue };
        match k.trim() {
            "Name" => name = Some(v.trim().to_string()),
            "MimeType" => types = v,
            "Type" => app = v.trim() == "Application",
            "Hidden" if v.trim() == "true" => return None,
            "NoDisplay" => nodisplay = v.trim() == "true",
            _ => {}
        }
    }
    let types: Vec<&str> = types.split(';').map(str::trim).collect();
    // Source files (text/x-python, …) are text: an editor that takes text/plain fits them too.
    let fit = !mime.is_empty() && (types.contains(&mime) || (mime.starts_with("text/") && types.contains(&"text/plain")));
    if app && (fit || !nodisplay) { Some((name?, fit)) } else { None }
}

/// Opens `path` with the app from `apps_for`, or (no app) the system's Open With dialog on Windows.
pub fn open_with(path: &str, app: Option<&str>) -> R<()> {
    if !Path::new(path).exists() {
        return Err(format!("Not found: {path}"));
    }
    let mut c = if cfg!(windows) {
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("shell32.dll,OpenAs_RunDLL").arg(path);
        c
    } else {
        let app = app.filter(|a| a.ends_with(".desktop") && Path::new(a).is_file()).ok_or("No app chosen")?;
        // gio honours the entry's Exec field codes and Terminal=true, which a hand-rolled Exec parser would get wrong.
        let mut c = clean(std::process::Command::new("gio"));
        c.args(["launch", app, path]);
        c
    };
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_files_folders_and_hidden() {
        let d = std::env::temp_dir().join(format!("ff-list-{}", std::process::id()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("a.txt"), b"hello").unwrap();
        std::fs::write(d.join(".dot"), b"").unwrap();
        let l = list(&s(&d)).unwrap();
        let get = |n: &str| l.entries.iter().find(|e| e.name == n).unwrap();
        assert!(get("sub").dir);
        assert_eq!(get("a.txt").size, 5);
        assert!(get(".dot").hidden && !get("a.txt").hidden);
        assert!(get("a.txt").mtime > 0.0);
        assert_eq!(l.parent.as_deref(), d.parent().map(s).as_deref());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn missing_folder_is_an_error() {
        assert!(list("/definitely/not/here/ff").is_err());
    }

    #[test]
    fn places_start_with_home() {
        assert_eq!(places()[0].kind, "home");
    }

    #[test]
    fn reachable_tells_folders_from_missing_paths() {
        let dir = std::env::temp_dir();
        assert_eq!(reachable(dir.to_string_lossy().into_owned()), "dir");
        let f = dir.join("inode-reachable-test.txt");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(reachable(f.to_string_lossy().into_owned()), "file");
        let _ = std::fs::remove_file(&f);
        assert_eq!(reachable("/no/such/folder/inode".into()), "");
    }

    #[test]
    fn props_totals_a_folder() {
        let d = std::env::temp_dir().join(format!("ff-props-{}", std::process::id()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("a"), b"12345").unwrap();
        std::fs::write(d.join("sub/b"), b"123").unwrap();
        let p = props(&s(&d)).unwrap();
        assert_eq!((p.size, p.files, p.folders), (8, 2, 1));
        assert!(p.mtime > 0.0);
        assert_eq!(props(&s(&d.join("a"))).unwrap().size, 5);
        #[cfg(unix)]
        assert!(p.mode.is_some());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn desktop_entries_fit_by_mime_type() {
        let e = "[Desktop Entry]\nType=Application\nName=Ed\nMimeType=text/plain;image/png;\n[Desktop Action x]\nName=Other\n";
        assert_eq!(desktop_app(e, "image/png"), Some(("Ed".into(), true)));
        assert_eq!(desktop_app(e, "text/x-python"), Some(("Ed".into(), true)));
        assert_eq!(desktop_app(e, "video/mp4"), Some(("Ed".into(), false)));
        assert_eq!(desktop_app(&format!("{e}\n[Desktop Entry]\nNoDisplay=true"), "video/mp4"), None);
        assert_eq!(desktop_app("[Desktop Entry]\nType=Application\nName=Gone\nHidden=true", ""), None);
        assert_eq!(desktop_app("[Desktop Entry]\nType=Link\nName=Web", ""), None);
    }
}
