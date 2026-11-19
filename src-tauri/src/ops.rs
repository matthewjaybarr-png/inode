//! File operations: copy/move between folders, rename, new folder, trash (with restore) and permanent delete.
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

type R<T> = Result<T, String>;

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
fn err(what: &str, p: &Path, e: std::io::Error) -> String {
    format!("{what} {}: {e}{}", s(p), hint(&e))
}
/// What to do about the common failures, so an error never stops at "os error 13".
fn hint(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match e.kind() {
        PermissionDenied => ". It is read-only or you lack permission here: pick a folder you can write to, or ask its owner.",
        ReadOnlyFilesystem => ". The drive is read-only: copy to a writable drive first.",
        NotFound => ". It is no longer there: the drive may be unplugged or disconnected. Reconnect it or refresh (F5).",
        _ => "",
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Policy {
    KeepBoth,
    Replace,
    Skip,
}

/// Names that `dest` already holds, so the UI can ask once before the batch starts.
pub fn conflicts(sources: &[String], dest: &str) -> Vec<String> {
    sources
        .iter()
        .filter_map(|src| Path::new(src).file_name())
        .filter(|n| Path::new(dest).join(n).symlink_metadata().is_ok())
        .map(|n| n.to_string_lossy().into_owned())
        .collect()
}

/// "a.txt" -> "a (2).txt", "dir" -> "dir (2)": the first name not taken in `dir`.
pub fn free_name(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let p = Path::new(name);
    let (stem, ext) = match (is_dir, p.file_stem(), p.extension()) {
        (false, Some(st), Some(e)) => (st.to_string_lossy().into_owned(), format!(".{}", e.to_string_lossy())),
        _ => (name.to_string(), String::new()),
    };
    (2..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|c| c.symlink_metadata().is_err()).unwrap()
}

fn total_bytes(p: &Path) -> u64 {
    match p.symlink_metadata() {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| total_bytes(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

pub struct Progress<'a> {
    pub done: u64,
    pub total: u64,
    pub report: &'a mut dyn FnMut(u64, u64, &str),
}

fn copy_file(src: &Path, dst: &Path, pr: &mut Progress) -> R<()> {
    let mut i = std::fs::File::open(src).map_err(|e| err("Cannot read", src, e))?;
    let md = i.metadata().map_err(|e| err("Cannot read", src, e))?;
    let mut o = std::fs::OpenOptions::new().write(true).create_new(true).open(dst).map_err(|e| err("Cannot write", dst, e))?;
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = i.read(&mut buf).map_err(|e| err("Cannot read", src, e))?;
        if n == 0 {
            break;
        }
        o.write_all(&buf[..n]).map_err(|e| err("Cannot write", dst, e))?;
        pr.done += n as u64;
        (pr.report)(pr.done, pr.total, &name);
    }
    let _ = o.set_permissions(md.permissions());
    if let Ok(t) = md.modified() {
        let _ = o.set_modified(t);
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path, pr: &mut Progress) -> R<()> {
    let md = src.symlink_metadata().map_err(|e| err("Cannot read", src, e))?;
    if md.file_type().is_symlink() {
        #[cfg(unix)]
        {
            let t = std::fs::read_link(src).map_err(|e| err("Cannot read", src, e))?;
            return std::os::unix::fs::symlink(t, dst).map_err(|e| err("Cannot write", dst, e));
        }
        // Junctions/symlinks need privileges to recreate on Windows; copy a file link's target, skip folder links.
        #[cfg(windows)]
        if std::fs::metadata(src).map(|m| m.is_dir()).unwrap_or(true) {
            return Ok(());
        }
    }
    if md.is_dir() {
        std::fs::create_dir(dst).map_err(|e| err("Cannot create", dst, e))?;
        for e in std::fs::read_dir(src).map_err(|e| err("Cannot open", src, e))?.flatten() {
            copy_tree(&e.path(), &dst.join(e.file_name()), pr)?;
        }
        Ok(())
    } else {
        copy_file(src, dst, pr)
    }
}

/// Removes a file, folder tree or link (never what a link points to).
fn remove(p: &Path) -> R<()> {
    let md = p.symlink_metadata().map_err(|e| err("Cannot delete", p, e))?;
    let r = if md.file_type().is_symlink() {
        // A Windows folder link (junction) is removed as a directory.
        if cfg!(windows) && std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false) { std::fs::remove_dir(p) } else { std::fs::remove_file(p) }
    } else if md.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
    r.map_err(|e| err("Cannot delete", p, e))
}

fn cross_device(e: &std::io::Error) -> bool {
    // EXDEV on Linux, ERROR_NOT_SAME_DEVICE on Windows.
    e.raw_os_error() == Some(if cfg!(windows) { 17 } else { 18 })
}

/// Moves one path: a rename when it can, else copy then delete the source.
fn move_one(src: &Path, dst: &Path, pr: &mut Progress) -> R<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => {
            pr.done += total_bytes(dst);
            Ok(())
        }
        Err(e) if cross_device(&e) => {
            copy_tree(src, dst, pr)?;
            remove(src)
        }
        Err(e) => Err(err("Cannot move", src, e)),
    }
}

/// Copies or moves each source into `dest`. Returns the (from, to) pairs that were done, for undo.
pub fn transfer(sources: &[String], dest: &str, mv: bool, policy: Policy, report: &mut dyn FnMut(u64, u64, &str)) -> R<Vec<(String, String)>> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("Not a folder: {}", s(dest)));
    }
    let total = sources.iter().map(|x| total_bytes(Path::new(x))).sum();
    let mut pr = Progress { done: 0, total, report };
    let mut done = Vec::new();
    for src in sources.iter().map(Path::new) {
        let Some(name) = src.file_name() else { continue };
        let is_dir = src.is_dir();
        if is_dir && dest.starts_with(src) {
            return Err(format!("Cannot put {} inside itself", s(src)));
        }
        let mut to = dest.join(name);
        if to == src {
            if mv {
                continue; // moving into the folder it is already in
            }
            to = free_name(dest, &name.to_string_lossy(), is_dir); // a copy beside itself is always "keep both"
        } else if to.symlink_metadata().is_ok() {
            match policy {
                Policy::Skip => continue,
                Policy::KeepBoth => to = free_name(dest, &name.to_string_lossy(), is_dir),
                Policy::Replace => remove(&to)?,
            }
        }
        if mv { move_one(src, &to, &mut pr)? } else { copy_tree(src, &to, &mut pr)? }
        done.push((s(src), s(&to)));
    }
    Ok(done)
}

/// Undo of a move: puts each `to` back at its `from`.
pub fn move_back(pairs: &[(String, String)]) -> R<()> {
    let mut sink = |_: u64, _: u64, _: &str| {};
    let mut pr = Progress { done: 0, total: 0, report: &mut sink };
    for (from, to) in pairs.iter().rev() {
        if Path::new(from).symlink_metadata().is_ok() {
            return Err(format!("Cannot undo: {from} exists again"));
        }
        move_one(Path::new(to), Path::new(from), &mut pr)?;
    }
    Ok(())
}

fn check_name(name: &str) -> R<()> {
    let bad: &[char] = if cfg!(windows) { &['/', '\\', ':', '*', '?', '"', '<', '>', '|'] } else { &['/'] };
    if name.trim().is_empty() || name == "." || name == ".." || name.contains(bad) || name.contains('\0') {
        return Err(format!("Not a valid name: {name}"));
    }
    if cfg!(windows) && name.ends_with(['.', ' ']) {
        return Err("Windows names cannot end with a dot or space".into());
    }
    Ok(())
}

/// Renames in place; returns the new path.
pub fn rename(path: &str, name: &str) -> R<String> {
    check_name(name)?;
    let from = Path::new(path);
    let to = from.with_file_name(name);
    // Only a case change ("a.txt" -> "A.txt") may land on an existing name (same file on Windows).
    if to.symlink_metadata().is_ok() && !s(&to).eq_ignore_ascii_case(path) {
        return Err(format!("{name} already exists"));
    }
    std::fs::rename(from, &to).map_err(|e| err("Cannot rename", from, e))?;
    Ok(s(&to))
}

pub fn new_folder(dir: &str) -> R<String> {
    let d = Path::new(dir);
    let p = if d.join("New folder").symlink_metadata().is_ok() { free_name(d, "New folder", true) } else { d.join("New folder") };
    std::fs::create_dir(&p).map_err(|e| err("Cannot create", &p, e))?;
    Ok(s(&p))
}

/// Undo of "New folder": only ever removes an empty folder, so nothing added since is lost.
pub fn remove_empty_folder(path: &str) -> R<()> {
    let p = Path::new(path);
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.into());
    let mut rd = std::fs::read_dir(p).map_err(|e| err("Cannot undo the new folder", p, e))?;
    if rd.next().is_some() {
        return Err(format!("{name} is no longer empty, so Undo left it in place"));
    }
    // remove_dir refuses a non-empty folder itself, so a file added this instant is safe too.
    std::fs::remove_dir(p).map_err(|e| err("Cannot remove", p, e))
}

pub fn delete(paths: &[String]) -> R<()> {
    paths.iter().try_for_each(|p| remove(Path::new(p)))
}

/// One trashed item and where it went, so undo can put it back.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Trashed {
    pub original: String,
    /// Linux: the file inside Trash/files. Windows: empty (found again by scanning the Recycle Bin).
    pub stored: String,
    pub info: String,
}

/// What a trash call did: undo records for what moved, messages for what did not (left untouched).
#[derive(Serialize, Debug, Default)]
pub struct TrashReport {
    pub items: Vec<Trashed>,
    pub failed: Vec<String>,
}

pub fn trash(paths: &[String]) -> TrashReport {
    let mut r = TrashReport::default();
    for p in paths {
        match platform::trash(Path::new(p)) {
            Ok(t) => r.items.push(t),
            Err(e) => r.failed.push(e),
        }
    }
    r
}

/// Whether normal Delete is recoverable for items in `dir`. Windows has no Recycle Bin on network,
/// removable or CD drives; Linux always has a trash (home, or .Trash-uid on the drive) or trash() errors.
pub fn has_bin(dir: &str) -> bool {
    platform::has_bin(Path::new(dir))
}

/// Puts items back. A name taken again comes back as "name (2)"; one failure does not stop the rest.
/// Ok holds notes about renamed items; Err lists what could not be restored (the rest were).
pub fn restore(items: &[Trashed]) -> R<Vec<String>> {
    let (mut notes, mut failed) = (Vec::new(), Vec::new());
    for t in items {
        let orig = Path::new(&t.original);
        let name = orig.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let r = platform::find(t).and_then(|(stored, info)| {
            let to = match orig.parent() {
                Some(dir) if orig.symlink_metadata().is_ok() => free_name(dir, &name, stored.is_dir()),
                _ => orig.to_path_buf(),
            };
            std::fs::rename(&stored, &to).map_err(|e| err("Cannot restore", orig, e))?;
            let _ = std::fs::remove_file(&info);
            Ok((to != orig).then(|| format!("{name} exists again, so it came back as {}", to.file_name().unwrap_or_default().to_string_lossy())))
        });
        match r {
            Ok(n) => notes.extend(n),
            Err(e) => failed.push(e),
        }
    }
    if failed.is_empty() {
        Ok(notes)
    } else {
        Err(format!("{}{}", failed.join("; "), if failed.len() < items.len() { format!(" (the other {} came back)", items.len() - failed.len()) } else { String::new() }))
    }
}

#[cfg(unix)]
mod platform {
    //! freedesktop.org Trash spec: home trash, or $topdir/.Trash-$uid for other disks.
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    extern "C" {
        fn getuid() -> u32;
        fn localtime_r(t: *const i64, tm: *mut Tm) -> *mut Tm;
    }
    #[repr(C)]
    struct Tm {
        sec: i32,
        min: i32,
        hour: i32,
        mday: i32,
        mon: i32,
        year: i32,
        wday: i32,
        yday: i32,
        isdst: i32,
        gmtoff: i64,
        zone: *const i8,
    }

    fn now_local() -> String {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let mut tm: Tm = unsafe { std::mem::zeroed() };
        unsafe { localtime_r(&t, &mut tm) };
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", tm.year + 1900, tm.mon + 1, tm.mday, tm.hour, tm.min, tm.sec)
    }

    pub fn encode(p: &Path) -> String {
        p.as_os_str()
            .as_bytes()
            .iter()
            .map(|&b| if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    }

    fn home_trash() -> PathBuf {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("Trash")
    }

    /// Top of the mount holding `p`: climb while the device stays the same.
    fn mount_top(p: &Path) -> PathBuf {
        let dev = p.symlink_metadata().map(|m| m.dev()).unwrap_or(0);
        let mut top = p.to_path_buf();
        while let Some(up) = top.parent() {
            if up.metadata().map(|m| m.dev()).unwrap_or(!dev) != dev {
                break;
            }
            top = up.to_path_buf();
        }
        top
    }

    /// Reserves a name in info/ (create_new is the lock), then moves the file into files/.
    fn put(trash: &Path, p: &Path, recorded: &Path) -> std::io::Result<Trashed> {
        let (files, info) = (trash.join("files"), trash.join("info"));
        std::fs::create_dir_all(&files)?;
        std::fs::create_dir_all(&info)?;
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for i in 1.. {
            let n = if i == 1 { name.clone() } else { format!("{name}.{i}") };
            let ip = info.join(format!("{n}.trashinfo"));
            let mut f = match std::fs::OpenOptions::new().write(true).create_new(true).open(&ip) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            };
            if files.join(&n).symlink_metadata().is_ok() {
                drop(f);
                let _ = std::fs::remove_file(&ip);
                continue;
            }
            write!(f, "[Trash Info]\nPath={}\nDeletionDate={}\n", encode(recorded), now_local())?;
            let fp = files.join(&n);
            if let Err(e) = std::fs::rename(p, &fp) {
                let _ = std::fs::remove_file(&ip);
                return Err(e);
            }
            return Ok(Trashed { original: s(p), stored: s(&fp), info: s(&ip) });
        }
        unreachable!()
    }

    pub fn trash(p: &Path) -> R<Trashed> {
        let p = &std::path::absolute(p).map_err(|e| err("Cannot trash", p, e))?;
        match put(&home_trash(), p, p) {
            Ok(t) => Ok(t),
            Err(e) if cross_device(&e) => {
                let top = mount_top(p);
                let tdir = top.join(format!(".Trash-{}", unsafe { getuid() }));
                put(&tdir, p, p.strip_prefix(&top).unwrap_or(p))
                    .map_err(|e| format!("Cannot move {} to a Trash on its drive ({e}). Nothing was deleted; Shift+Delete deletes it permanently instead.", s(p)))
            }
            Err(e) => Err(err("Cannot trash", p, e)),
        }
    }

    /// Where the item sits in the trash and its .trashinfo.
    pub fn find(t: &Trashed) -> R<(PathBuf, PathBuf)> {
        let stored = PathBuf::from(&t.stored);
        if stored.symlink_metadata().is_err() {
            return Err(format!("{} is no longer in the Trash", t.original));
        }
        Ok((stored, PathBuf::from(&t.info)))
    }

    pub fn has_bin(_: &Path) -> bool {
        true
    }
}

#[cfg(windows)]
mod platform {
    //! Recycle Bin through the shell (per-user, no admin). Undo finds the item again from its $I record.
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct ShFileOp {
        hwnd: isize,
        func: u32,
        from: *const u16,
        to: *const u16,
        flags: u16,
        aborted: i32,
        mappings: *mut u8,
        title: *const u16,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(op: *mut ShFileOp) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }

    /// Only fixed disks (3) and RAM disks (6) have a Recycle Bin; network (4), removable (2) and CD (5) drives do not.
    /// shortcut: a known folder redirected to a share does have one, but is treated as none (we warn, never lose data).
    pub fn has_bin(p: &Path) -> bool {
        let root = std::path::absolute(p).ok().and_then(|a| a.ancestors().last().map(Path::to_path_buf));
        let Some(root) = root else { return false };
        let mut w: Vec<u16> = root.as_os_str().encode_wide().collect();
        if w.last() != Some(&(b'\\' as u16)) {
            w.push(b'\\' as u16);
        }
        w.push(0);
        matches!(unsafe { GetDriveTypeW(w.as_ptr()) }, 3 | 6)
    }

    fn why(rc: i32) -> &'static str {
        match rc {
            0x20 | 0x21 => "it is open in another program. Close it there and try again",
            0x5 | 0x78 | 0x13 => "Windows denied access (read-only, or no permission). Check the item's permissions",
            0x2 | 0x3 | 0x7C => "it is no longer there. Refresh (F5)",
            0x15 | 0x35 | 0x37 | 0x40 | 0x43 => "the drive is not available. Reconnect it and try again",
            _ => "Windows refused",
        }
    }
    const FO_DELETE: u32 = 3;
    // FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI | FOF_WANTNUKEWARNING
    const FLAGS: u16 = 0x4 | 0x10 | 0x40 | 0x400 | 0x4000;

    pub fn trash(p: &Path) -> R<Trashed> {
        let p = std::path::absolute(p).map_err(|e| err("Cannot trash", p, e))?;
        if p.symlink_metadata().is_err() {
            return Err(format!("Not found: {}. Refresh (F5)", s(&p)));
        }
        // Without a bin the shell would delete for good; the UI asks first and calls delete_paths instead.
        if !has_bin(&p) {
            return Err(format!("{} is on a drive with no Recycle Bin; nothing was deleted", s(&p)));
        }
        let mut from: Vec<u16> = p.as_os_str().encode_wide().collect();
        from.extend([0, 0]); // double-null list of one path
        let mut op = ShFileOp { hwnd: 0, func: FO_DELETE, from: from.as_ptr(), to: std::ptr::null(), flags: FLAGS, aborted: 0, mappings: std::ptr::null_mut(), title: std::ptr::null() };
        let rc = unsafe { SHFileOperationW(&mut op) };
        if rc != 0 || op.aborted != 0 || p.symlink_metadata().is_ok() {
            return Err(format!("Cannot move {} to the Recycle Bin: {} (code {rc:#x}). Nothing was deleted.", s(&p), why(rc)));
        }
        Ok(Trashed { original: s(&p), stored: String::new(), info: String::new() })
    }

    /// Original path and deletion time from a $I file (format 1: fixed 260 chars; format 2: length-prefixed).
    pub fn read_i(b: &[u8]) -> Option<(String, i64)> {
        let ver = i64::from_le_bytes(b.get(0..8)?.try_into().ok()?);
        let when = i64::from_le_bytes(b.get(16..24)?.try_into().ok()?);
        let units: Vec<u16> = match ver {
            1 => b.get(24..24 + 520)?.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect(),
            2 => {
                let n = u32::from_le_bytes(b.get(24..28)?.try_into().ok()?) as usize;
                b.get(28..28 + n * 2)?.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
            }
            _ => return None,
        };
        let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
        Some((String::from_utf16_lossy(&units[..end]), when))
    }

    /// The newest $R/$I pair recorded for the original path.
    pub fn find(t: &Trashed) -> R<(PathBuf, PathBuf)> {
        let root = Path::new(&t.original).components().next().map(|c| PathBuf::from(c.as_os_str()).join("\\$Recycle.Bin")).ok_or("Bad path")?;
        let mut best: Option<(i64, PathBuf)> = None;
        // Only the current user's SID folder is readable; the others fail and are skipped.
        for sid in std::fs::read_dir(&root).map_err(|e| err("Cannot open", &root, e))?.flatten() {
            let Ok(rd) = std::fs::read_dir(sid.path()) else { continue };
            for f in rd.flatten() {
                let n = f.file_name().to_string_lossy().into_owned();
                if !n.starts_with("$I") {
                    continue;
                }
                if let Some((orig, when)) = std::fs::read(f.path()).ok().and_then(|b| read_i(&b)) {
                    if orig.eq_ignore_ascii_case(&t.original) && best.as_ref().is_none_or(|(w, _)| when > *w) {
                        best = Some((when, f.path()));
                    }
                }
            }
        }
        let (_, ipath) = best.ok_or_else(|| format!("{} is no longer in the Recycle Bin", t.original))?;
        let rpath = ipath.with_file_name(ipath.file_name().unwrap().to_string_lossy().replacen("$I", "$R", 1));
        Ok((rpath, ipath))
    }
}

/// The archive name: "Photos" -> "Photos.zip", "report.pdf" -> "report.zip", several items -> "Archive.zip".
fn zip_name(sources: &[String]) -> String {
    let p = Path::new(&sources[0]);
    let one = if p.is_dir() { p.file_name() } else { p.file_stem() };
    let base = one.filter(|_| sources.len() == 1).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Archive".into());
    format!("{base}.zip")
}

/// Zips `sources` into a new archive beside the first one (never over an existing file); returns the archive path.
pub fn compress(sources: &[String], report: &mut dyn FnMut(u64, u64, &str)) -> R<String> {
    let first = Path::new(sources.first().ok_or("Nothing to compress")?);
    let dir = first.parent().ok_or("Cannot compress a drive root")?;
    let name = zip_name(sources);
    let out = if dir.join(&name).symlink_metadata().is_ok() { free_name(dir, &name, false) } else { dir.join(&name) };
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&out).map_err(|e| err("Cannot write", &out, e))?;
    let total = sources.iter().map(|x| total_bytes(Path::new(x))).sum();
    let mut pr = Progress { done: 0, total, report };
    let mut zw = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let res = sources.iter().try_for_each(|src| {
        let src = Path::new(src);
        let top = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        zip_tree(&mut zw, src, &top, &mut pr)
    });
    // A half-written archive is worse than none: remove it on any failure.
    match res.and_then(|_| zw.finish().map(|_| ()).map_err(|e| err("Cannot write", &out, std::io::Error::other(e)))) {
        Ok(()) => Ok(s(&out)),
        Err(e) => {
            let _ = std::fs::remove_file(&out);
            Err(e)
        }
    }
}

fn zip_tree<W: Write + std::io::Seek>(zw: &mut zip::ZipWriter<W>, src: &Path, entry: &str, pr: &mut Progress) -> R<()> {
    let md = std::fs::symlink_metadata(src).map_err(|e| err("Cannot read", src, e))?;
    let zerr = |e: zip::result::ZipError| err("Cannot write", src, std::io::Error::other(e));
    let mut opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(md.len() >= u32::MAX as u64);
    // Zip dates are local wall-clock time; without this every entry extracts as 1980-01-01.
    if let Some(t) = md.modified().ok().and_then(|t| zip::DateTime::try_from(chrono::DateTime::<chrono::Local>::from(t).naive_local()).ok()) {
        opt = opt.last_modified_time(t);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        opt = opt.unix_permissions(md.permissions().mode() & 0o7777);
    }
    if md.is_dir() {
        zw.add_directory(format!("{entry}/"), opt).map_err(zerr)?;
        let mut kids: Vec<_> = std::fs::read_dir(src).map_err(|e| err("Cannot read", src, e))?.flatten().collect();
        kids.sort_by_key(|k| k.file_name());
        for k in kids {
            zip_tree(zw, &k.path(), &format!("{entry}/{}", k.file_name().to_string_lossy()), pr)?;
        }
        return Ok(());
    }
    if md.file_type().is_symlink() && src.is_dir() {
        return Ok(()); // shortcut: links to folders are left out (no loops); store them as links if anyone asks
    }
    zw.start_file(entry, opt).map_err(zerr)?;
    let mut i = std::fs::File::open(src).map_err(|e| err("Cannot read", src, e))?;
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = i.read(&mut buf).map_err(|e| err("Cannot read", src, e))?;
        if n == 0 {
            return Ok(());
        }
        zw.write_all(&buf[..n]).map_err(|e| err("Cannot write", src, e))?;
        pr.done += n as u64;
        (pr.report)(pr.done, pr.total, &name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ff-ops-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn none() -> impl FnMut(u64, u64, &str) {
        |_, _, _| {}
    }

    #[test]
    fn free_names() {
        let d = tmp("free");
        std::fs::write(d.join("a.txt"), "").unwrap();
        std::fs::write(d.join("a (2).txt"), "").unwrap();
        assert_eq!(free_name(&d, "a.txt", false), d.join("a (3).txt"));
        assert_eq!(free_name(&d, "my.dir", true), d.join("my.dir (2)"));
        assert_eq!(free_name(&d, ".bashrc", false), d.join(".bashrc (2)"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn copy_tree_with_conflicts_and_progress() {
        let d = tmp("copy");
        let (a, b) = (d.join("a"), d.join("b"));
        std::fs::create_dir_all(a.join("sub")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("sub/f.txt"), "12345").unwrap();
        std::fs::write(a.join("x.txt"), "abc").unwrap();
        std::fs::write(b.join("x.txt"), "old").unwrap();
        let src = vec![s(&a.join("sub")), s(&a.join("x.txt"))];
        assert_eq!(conflicts(&src, &s(&b)), vec!["x.txt"]);
        let mut last = (0, 0);
        let done = transfer(&src, &s(&b), false, Policy::KeepBoth, &mut |d, t, _| last = (d, t)).unwrap();
        assert_eq!(last, (8, 8));
        assert_eq!(std::fs::read_to_string(b.join("sub/f.txt")).unwrap(), "12345");
        assert_eq!(std::fs::read_to_string(b.join("x.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(b.join("x (2).txt")).unwrap(), "abc");
        assert_eq!(done.len(), 2);
        // Replace and Skip
        transfer(&[s(&a.join("x.txt"))], &s(&b), false, Policy::Replace, &mut none()).unwrap();
        assert_eq!(std::fs::read_to_string(b.join("x.txt")).unwrap(), "abc");
        assert!(transfer(&[s(&a.join("x.txt"))], &s(&b), false, Policy::Skip, &mut none()).unwrap().is_empty());
        // Copy beside itself never replaces the source
        transfer(&[s(&a.join("x.txt"))], &s(&a), false, Policy::Replace, &mut none()).unwrap();
        assert!(a.join("x.txt").exists() && a.join("x (2).txt").exists());
        // A folder cannot go inside itself
        assert!(transfer(&[s(&a)], &s(&a.join("sub")), false, Policy::KeepBoth, &mut none()).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn move_and_undo() {
        let d = tmp("move");
        let (a, b) = (d.join("a"), d.join("b"));
        std::fs::create_dir_all(a.join("dir")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("dir/f"), "x").unwrap();
        let pairs = transfer(&[s(&a.join("dir"))], &s(&b), true, Policy::KeepBoth, &mut none()).unwrap();
        assert!(!a.join("dir").exists() && b.join("dir/f").exists());
        move_back(&pairs).unwrap();
        assert!(a.join("dir/f").exists() && !b.join("dir").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rename_new_folder_delete() {
        let d = tmp("ren");
        let f = new_folder(&s(&d)).unwrap();
        assert!(f.ends_with("New folder"));
        assert!(new_folder(&s(&d)).unwrap().ends_with("New folder (2)"));
        let r = rename(&f, "Plans").unwrap();
        assert!(Path::new(&r).is_dir());
        assert!(rename(&r, "New folder (2)").is_err());
        assert!(rename(&r, "a/b").is_err() && rename(&r, "..").is_err());
        std::fs::write(Path::new(&r).join("x"), "1").unwrap();
        delete(&[r.clone()]).unwrap();
        assert!(!Path::new(&r).exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn trash_and_restore_home_trash() {
        let d = tmp("trash");
        let data = d.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("XDG_DATA_HOME", &data); // a private trash, not the real one
        let f = d.join("doc 1.txt");
        std::fs::write(&f, "keep").unwrap();
        let full = d.join("full");
        std::fs::create_dir_all(full.join("sub")).unwrap();
        std::fs::write(full.join("sub/x.txt"), "x").unwrap();
        // A missing path fails alone; the others still go, each with an undo record.
        let r = trash(&[s(&f), s(&d.join("gone")), s(&full)]);
        assert_eq!((r.items.len(), r.failed.len()), (2, 1), "{:?}", r.failed);
        let t = r.items;
        assert!(!f.exists() && !full.exists() && Path::new(&t[0].stored).exists());
        let info = std::fs::read_to_string(&t[0].info).unwrap();
        assert!(info.contains("Path=") && info.contains("doc%201.txt") && info.contains("DeletionDate=20"), "{info}");
        // The name was taken again meanwhile: it comes back beside it, nothing overwritten.
        std::fs::write(&f, "new").unwrap();
        let notes = restore(&t).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(d.join("doc 1 (2).txt")).unwrap(), "keep");
        assert_eq!(std::fs::read_to_string(full.join("sub/x.txt")).unwrap(), "x");
        assert!(notes.len() == 1 && notes[0].contains("doc 1 (2).txt"), "{notes:?}");
        assert!(!Path::new(&t[0].info).exists());
        assert!(restore(&t).unwrap_err().contains("no longer in the Trash"));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn new_folder_undo_only_when_empty() {
        let d = tmp("nf");
        let a = new_folder(&s(&d)).unwrap();
        remove_empty_folder(&a).unwrap();
        assert!(!Path::new(&a).exists());
        let b = new_folder(&s(&d)).unwrap();
        std::fs::write(Path::new(&b).join("work.txt"), "w").unwrap();
        assert!(remove_empty_folder(&b).unwrap_err().contains("no longer empty"));
        assert!(Path::new(&b).join("work.txt").exists());
        assert!(rename(&b, "x/y").is_err() && has_bin(&s(&d)));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn compress_names_and_contents() {
        let d = tmp("zip");
        std::fs::create_dir_all(d.join("Photos/sub")).unwrap();
        std::fs::write(d.join("Photos/a.txt"), "hello").unwrap();
        std::fs::write(d.join("report.pdf"), "pdf").unwrap();
        let one = |p: &str| vec![s(&d.join(p))];
        let z = compress(&one("Photos"), &mut none()).unwrap();
        assert_eq!(z, s(&d.join("Photos.zip")));
        let mut a = zip::ZipArchive::new(std::fs::File::open(&z).unwrap()).unwrap();
        let mut names: Vec<_> = a.file_names().map(String::from).collect();
        names.sort();
        assert_eq!(names, ["Photos/", "Photos/a.txt", "Photos/sub/"]);
        let mut text = String::new();
        a.by_name("Photos/a.txt").unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "hello");
        assert!(a.by_name("Photos/a.txt").unwrap().last_modified().unwrap().year() > 1980, "keeps the file's date");
        assert_eq!(compress(&one("report.pdf"), &mut none()).unwrap(), s(&d.join("report.zip")));
        assert_eq!(compress(&one("report.pdf"), &mut none()).unwrap(), s(&d.join("report (2).zip")));
        assert_eq!(compress(&[s(&d.join("Photos")), s(&d.join("report.pdf"))], &mut none()).unwrap(), s(&d.join("Archive.zip")));
        assert!(compress(&one("missing"), &mut none()).is_err());
        assert!(!d.join("missing.zip").exists(), "a failed archive is removed");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
