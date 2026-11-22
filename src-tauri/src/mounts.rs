//! Network places, phones and encrypted drives (Linux): what the sidebar lists beyond plain drives, and the
//! commands that mount, unlock and unmount them. gvfs (`gio`) does the network and phone work, udisks the disks.
//! Passwords and passphrases reach the child process on its stdin only: never in argv, never in a message.
use crate::fs::{clean, s, unpercent, Place};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

type R<T> = Result<T, String>;

/// Sidebar path of the "Connect to server…" row; the UI opens the address box for it.
const CONNECT: &str = "connect:";
/// Sidebar path prefix of a locked encrypted drive: "luks:/dev/sdb1".
const LUKS: &str = "luks:";
/// What `connect` accepts. gvfs decides what each one needs; this list only keeps other things away from `gio`.
const SCHEMES: [&str; 12] = ["smb", "sftp", "ssh", "ftp", "ftps", "dav", "davs", "nfs", "afp", "mtp", "gphoto2", "afc"];
const PHONES: [&str; 3] = ["mtp", "gphoto2", "afc"];

pub struct Mount {
    pub dev: String,
    pub dir: String,
    pub fstype: String,
}

/// /proc/mounts writes space, tab, newline and backslash as \040 \011 \012 \134.
fn unescape(text: &str) -> String {
    let b = text.as_bytes();
    let (mut out, mut i) = (Vec::with_capacity(b.len()), 0);
    while i < b.len() {
        let oct = (b[i] == b'\\').then(|| b.get(i + 1..i + 4)).flatten().and_then(|d| u8::from_str_radix(std::str::from_utf8(d).ok()?, 8).ok());
        out.push(oct.unwrap_or(b[i]));
        i += if oct.is_some() { 4 } else { 1 };
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_mounts(text: &str) -> Vec<Mount> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.split(' ');
            Some(Mount { dev: unescape(f.next()?), dir: unescape(f.next()?), fstype: f.next()?.to_string() })
        })
        .collect()
}

fn mounts() -> Vec<Mount> {
    parse_mounts(&std::fs::read_to_string("/proc/mounts").unwrap_or_default())
}

/// A share mounted outside gvfs (fstab, mount.cifs, sshfs, rclone …). Every FUSE mount counts except the
/// desktop's own plumbing: gvfs' root, the document portal, and the images AppImages run from.
fn is_network(m: &Mount) -> bool {
    matches!(m.fstype.as_str(), "cifs" | "smb3" | "nfs" | "nfs4" | "davfs" | "ceph" | "afs" | "ncpfs")
        || (m.fstype.starts_with("fuse.") && !matches!(m.fstype.as_str(), "fuse.gvfsd-fuse" | "fuse.portal" | "fuse.lxcfs" | "fuse.gocryptfs") && !m.dir.starts_with("/tmp/.mount_"))
}

/// Where gvfs shows its mounts as folders.
fn gvfs_root() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?).join("gvfs"))
}

/// A gvfs mount folder's name as (scheme, name to show, host):
/// "smb-share:server=nas,share=docs" -> ("smb", "docs on nas", "nas"); "mtp:host=Pixel_6" -> ("mtp", "Pixel 6", "Pixel_6").
fn gvfs_name(dir: &str) -> (String, String, String) {
    let (kind, rest) = dir.split_once(':').unwrap_or((dir, ""));
    let get = |key: &str| rest.split(',').find_map(|kv| kv.strip_prefix(key)?.strip_prefix('=')).map(unpercent);
    let scheme = kind.strip_suffix("-share").unwrap_or(kind).to_string();
    let host = get("server").or_else(|| get("host")).unwrap_or_else(|| dir.to_string());
    let name = if PHONES.contains(&scheme.as_str()) {
        host.replace('_', " ")
    } else {
        let at = get("user").map(|u| format!("{u}@{host}")).unwrap_or_else(|| host.clone());
        get("share").map(|sh| format!("{sh} on {host}")).unwrap_or_else(|| format!("{at} ({scheme})"))
    };
    (scheme, name, host)
}

/// (name, address) of every volume `gio mount -li` lists with an address to mount: phones and cameras that are plugged in.
fn parse_volumes(text: &str) -> Vec<(String, String)> {
    let (mut v, mut name) = (Vec::new(), None);
    for l in text.lines().map(str::trim_start) {
        if let Some(rest) = l.strip_prefix("Volume(") {
            name = rest.split_once("): ").map(|x| x.1.to_string());
        } else if l.starts_with("Drive(") || l.starts_with("Mount(") {
            name = None;
        } else if let Some(root) = l.strip_prefix("activation_root=") {
            if let Some(n) = name.take() {
                v.push((n, root.to_string()));
            }
        }
    }
    v
}

/// (device, name to show) of every LUKS volume that is still locked, from `lsblk -J -o PATH,KNAME,PKNAME,FSTYPE,LABEL,SIZE`.
/// Unlocked ones have a mapped device whose parent they are.
fn parse_locked(json: &str) -> Vec<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let devs = v["blockdevices"].as_array().cloned().unwrap_or_default();
    let text = |d: &serde_json::Value, k: &str| d[k].as_str().unwrap_or("").to_string();
    devs.iter()
        .filter(|d| d["fstype"] == "crypto_LUKS" && !devs.iter().any(|c| c["pkname"] == d["kname"]))
        .map(|d| (text(d, "path"), if d["label"].is_string() { text(d, "label") } else { format!("{} encrypted drive", text(d, "size")) }))
        .collect()
}

fn locked() -> Vec<(String, String)> {
    let o = clean(Command::new("lsblk")).args(["-J", "-o", "PATH,KNAME,PKNAME,FSTYPE,LABEL,SIZE"]).output();
    o.map(|o| parse_locked(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
}

/// The sidebar's Network section and the phones and locked drives of its Drives section.
/// shortcut: asks gio and lsblk on every call (about half a second, off the UI thread); watch udev / the gvfs
/// volume monitor instead if the sidebar should react the moment something is plugged in.
pub fn places() -> Vec<Place> {
    let place = |name: String, title: String, path: String, kind, eject| Place { name, title, path, kind, eject };
    let mut v = vec![place("Connect to server…".into(), "Open a network address: smb://server/share, sftp://user@server/folder, ftp://, dav://, davs:// (Ctrl+K)".into(), CONNECT.into(), "connect", false)];
    for m in mounts().into_iter().filter(is_network) {
        let name = Path::new(&m.dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| m.dir.clone());
        // Only the user's own FUSE mounts come off without root.
        v.push(place(name, format!("{} ({})", m.dir, m.dev), m.dir, "network", m.fstype.starts_with("fuse.")));
    }
    let mut open_phones = Vec::new();
    for de in gvfs_root().and_then(|g| std::fs::read_dir(g).ok()).into_iter().flatten().flatten() {
        let (scheme, name, host) = gvfs_name(&de.file_name().to_string_lossy());
        let phone = PHONES.contains(&scheme.as_str());
        if phone {
            open_phones.push((scheme, host));
        }
        v.push(place(name, s(&de.path()), s(&de.path()), if phone { "phone" } else { "network" }, true));
    }
    // Plugged in but not opened yet: the row holds the address, and opening it mounts the phone first.
    let gio = clean(Command::new("gio")).args(["mount", "-li"]).output();
    for (name, uri) in gio.map(|o| parse_volumes(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default() {
        let Some((scheme, rest)) = uri.split_once("://") else { continue };
        let host = unpercent(rest.trim_end_matches('/'));
        if PHONES.contains(&scheme) && !open_phones.iter().any(|(sc, h)| sc == scheme && *h == host) {
            v.push(place(name, "Plugged in, not opened yet. Unlock the phone's screen, then click here.".into(), uri, "phone", false));
        }
    }
    for (dev, name) in locked() {
        v.push(place(name, format!("Encrypted drive {dev}, locked. Click to type its passphrase."), format!("{LUKS}{dev}"), "locked", false));
    }
    for m in mounts().into_iter().filter(|m| m.fstype == "fuse.gocryptfs") {
        let name = Path::new(&m.dev).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| m.dir.clone());
        v.push(place(name, format!("Locked folder {}, open now. Eject locks it again.", m.dev), m.dir, "vault", true));
    }
    v
}

/// The human part of a tool's error: its last line, without the "gio: smb://…: " or "Error …: GDBus.Error:…: " lead-in.
fn plain(stderr: &str) -> String {
    let line = stderr.trim().lines().last().unwrap_or("").trim();
    let line = line.strip_prefix("gio: ").unwrap_or(line);
    match line.split_once(": ") {
        Some((lead, rest)) if lead.contains("://") => rest.to_string(),
        _ if line.contains("GDBus.Error") => line.rsplit(": ").next().unwrap_or(line).to_string(),
        _ => line.to_string(),
    }
}

/// Runs a tool with `input` on its stdin (then end-of-file): (succeeded, stdout, stderr).
fn run(tool: &str, args: &[&str], input: &str) -> R<(bool, String, String)> {
    let mut c = clean(Command::new(tool));
    // English prompts and errors (the prompts are parsed); the character set stays as it is.
    c.args(args).env("LANGUAGE", "C").env("LC_MESSAGES", "C").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("{tool} is not available: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()); // a tool that needs no input may have gone already
    }
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((o.status.success(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned()))
}

/// Unmounts what udisks does not own: gvfs mounts (network places, phones) and the user's FUSE mounts.
/// None = not one of those, so `fs::eject` carries on with udisks.
pub fn eject(path: &str) -> Option<R<()>> {
    let done = |r: R<(bool, String, String)>| r.and_then(|(ok, _, err)| if ok { Ok(()) } else { Err(plain(&err)) });
    if gvfs_root().is_some_and(|g| Path::new(path).starts_with(g)) {
        return Some(done(run("gio", &["mount", "-u", path], "")));
    }
    let m = mounts().into_iter().find(|m| m.dir == path)?;
    let r = m.fstype.starts_with("fuse.").then(|| done(run("fusermount3", &["-u", path], "")))?;
    // A locked folder's readable view: its empty mount point goes too.
    if r.is_ok() && views_root().is_ok_and(|v| Path::new(path).starts_with(v)) {
        let _ = std::fs::remove_dir(path);
    }
    Some(r)
}

/// The partition under an unlocked LUKS volume ("/dev/dm-3" -> "/dev/sdb1"), so eject can lock it again. `sys` = /sys/class/block.
pub fn luks_parent(sys: &Path, dev: &str) -> Option<String> {
    let real = std::fs::canonicalize(dev).unwrap_or_else(|_| PathBuf::from(dev));
    let node = sys.join(real.file_name()?);
    if !std::fs::read_to_string(node.join("dm/uuid")).ok()?.starts_with("CRYPT-LUKS") {
        return None;
    }
    let under = std::fs::read_dir(node.join("slaves")).ok()?.flatten().next()?;
    Some(format!("/dev/{}", under.file_name().to_string_lossy()))
}

/// Unlocks a locked encrypted drive and mounts it; returns the folder it is mounted at.
/// udisks needs no root (polkit decides, and asks if it must).
/// shortcut: mounts the one filesystem inside; a LUKS volume holding LVM unlocks but has nothing to mount here.
pub fn unlock(device: &str, passphrase: &str) -> R<String> {
    // Only a drive the sidebar lists as locked: the name is handed to udisksctl.
    if !locked().iter().any(|(d, _)| d == device) {
        return Err(format!("{device} is not a locked encrypted drive"));
    }
    // --key-file /dev/stdin: udisksctl would otherwise ask on a terminal. The bytes are the passphrase, no newline.
    let (ok, out, err) = run("udisksctl", &["unlock", "-b", device, "--key-file", "/dev/stdin"], passphrase)?;
    if !ok {
        return Err(plain(&err));
    }
    // "Unlocked /dev/sdb1 as /dev/dm-3."
    let mapped = out.trim().rsplit(" as ").next().unwrap_or("").trim_end_matches('.').to_string();
    let (ok, _, err) = run("udisksctl", &["mount", "-b", &mapped], "")?;
    if !ok {
        return Err(format!("Unlocked, but it could not be mounted: {}", plain(&err)));
    }
    let real = std::fs::canonicalize(&mapped).ok();
    let at = mounts().into_iter().find(|m| m.dev == mapped || (real.is_some() && std::fs::canonicalize(&m.dev).ok() == real));
    at.map(|m| m.dir).ok_or_else(|| "Unlocked and mounted, but the folder was not found".into())
}

// Locked folders: a gocryptfs folder on disk holds only scrambled files (names too). Unlocking mounts the readable
// view under $XDG_RUNTIME_DIR/inode-locked/<name>; eject (fusermount3) locks it again. The password reaches
// gocryptfs on its stdin, which it reads instead of a terminal. No list of them is kept: /proc/mounts is the state.

/// Whether `dir` is a gocryptfs folder (the scrambled side).
pub fn is_locked_folder(dir: &Path) -> bool {
    dir.join("gocryptfs.conf").is_file() && dir.join("gocryptfs.diriv").is_file()
}

/// Where a locked folder is open right now (its mount shows the scrambled folder as the device).
pub fn open_view(cipher: &Path) -> Option<String> {
    let c = std::fs::canonicalize(cipher).ok()?;
    mounts().into_iter().find(|m| m.fstype == "fuse.gocryptfs" && Path::new(&m.dev) == c).map(|m| m.dir)
}

fn views_root() -> R<PathBuf> {
    Ok(PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or("XDG_RUNTIME_DIR is not set")?).join("inode-locked"))
}

/// The recovery key in `gocryptfs -init`'s output: the line of eight dash-separated groups of eight hex digits.
/// The master key from `gocryptfs-xray -dumpmasterkey` (64 hex digits on a line), shown in 8 groups like gocryptfs does.
/// `gocryptfs -init` itself prints no key when its stdin is not a terminal.
fn recovery_key(out: &str) -> Option<String> {
    let hex = out.lines().map(str::trim).find(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit()))?;
    Some(hex.as_bytes().chunks(8).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-"))
}

/// Makes a new, empty locked folder `name` in `dir`; returns (its path, the recovery key to show once).
pub fn make_locked(dir: &str, name: &str, password: &str) -> R<(String, String)> {
    if password.is_empty() {
        return Err("The password cannot be empty".into());
    }
    let path = crate::ops::make_new(dir, Some(name), true)?;
    let made = run("gocryptfs", &["-init", "--", &path], password).and_then(|(ok, _, err)| {
        if !ok {
            return Err(plain(&err));
        }
        let conf = format!("{path}/gocryptfs.conf");
        let (_, out, _) = run("gocryptfs-xray", &["-dumpmasterkey", &conf], password)?;
        recovery_key(&out).ok_or_else(|| "gocryptfs printed no recovery key".to_string())
    });
    match made {
        Ok(key) => Ok((path, key)),
        Err(e) => {
            // Leave nothing half-made behind.
            let _ = std::fs::remove_dir_all(&path);
            Err(if e.contains("not available") { "gocryptfs is not installed (sudo pacman -S gocryptfs)".into() } else { e })
        }
    }
}

/// Opens a locked folder; returns the folder where its files can be read. Already open = no password needed.
pub fn unlock_folder(cipher: &str, password: &str) -> R<String> {
    let c = Path::new(cipher);
    if !is_locked_folder(c) {
        return Err(format!("{cipher} is not a locked folder"));
    }
    if let Some(at) = open_view(c) {
        return Ok(at);
    }
    let root = views_root()?;
    let name = c.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Locked folder".into());
    // A free, empty mount point: "Private", "Private 2", …
    let at = (1..100)
        .map(|n| root.join(if n == 1 { name.clone() } else { format!("{name} {n}") }))
        .find(|p| std::fs::read_dir(p).map_or(true, |mut d| d.next().is_none()) && !mounts().iter().any(|m| Path::new(&m.dir) == p))
        .ok_or("No free place to open it")?;
    std::fs::create_dir_all(&at).map_err(|e| e.to_string())?;
    let at_s = s(&at);
    let (ok, _, err) = run("gocryptfs", &["-q", "--", cipher, &at_s], password).map_err(|e| if e.contains("not available") { "gocryptfs is not installed (sudo pacman -S gocryptfs)".into() } else { e })?;
    if !ok {
        let _ = std::fs::remove_dir(&at);
        // gocryptfs says "Password incorrect." on a wrong password.
        return Err(if err.contains("Password incorrect") { "Wrong password".into() } else { plain(&err) });
    }
    Ok(at_s)
}

/// The address as `gio mount` gets it, or why it is refused. Addresses are typed by the user or come from a
/// sidebar row, so nothing but a known scheme and a server passes.
pub fn check_address(address: &str) -> R<&str> {
    let a = address.trim();
    let (scheme, rest) = a.split_once("://").ok_or("A network address looks like smb://server/share or sftp://user@server/folder")?;
    if !SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
        return Err(format!("Inode cannot open {scheme}:// addresses. It knows smb, sftp, ftp, ftps, dav, davs, nfs and afp."));
    }
    if rest.is_empty() || rest.starts_with('/') {
        return Err("The address has no server name".into());
    }
    if a.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("An address cannot contain spaces (write %20 for a space)".into());
    }
    if rest.split('/').next().and_then(|host| host.rsplit_once('@')).is_some_and(|(user, _)| user.contains(':')) {
        return Err("Leave the password out of the address: Inode asks for it and never stores it".into());
    }
    Ok(a)
}

#[derive(Debug, PartialEq)]
enum Prompt {
    /// With the user name gio offers as the default.
    User(String),
    Domain,
    Password,
    /// A question with numbered answers (an unknown SSH host key: [1] Log In Anyway, [2] Cancel Login).
    Choice,
}

/// The prompts `gio mount` printed, in order. They look like "User [matt]: ", "Domain [WORKGROUP]: ", "Password: ", "Choice: ".
fn prompts(out: &str) -> Vec<Prompt> {
    let mut found = Vec::new();
    for label in ["User", "Domain", "Password", "Choice"] {
        for (i, _) in out.match_indices(label) {
            let rest = &out[i + label.len()..];
            let default = if rest.starts_with(": ") || rest == ":" {
                Some("")
            } else {
                rest.strip_prefix(" [").and_then(|r| r.split_once("]:")).map(|x| x.0).filter(|d| !d.contains('\n'))
            };
            if let Some(d) = default {
                found.push((i, match label { "User" => Prompt::User(d.into()), "Domain" => Prompt::Domain, "Password" => Prompt::Password, _ => Prompt::Choice }));
            }
        }
    }
    found.sort_by_key(|f| f.0);
    found.into_iter().map(|f| f.1).collect()
}

/// What to type at the prompt gio stopped at (`asked[given]`). Err = stop and tell the UI: "auth:user:<default>" or
/// "auth:password" (ask the user and call again), "trust:<the question>" (confirm and call again), else a plain reason.
/// "DOMAIN\user" as the user name answers the Domain prompt too.
fn answer(asked: &[Prompt], given: usize, user: Option<&str>, password: Option<&str>, trust: bool, out: &str) -> R<String> {
    let (domain, name) = match user.and_then(|u| u.split_once('\\')) {
        Some((d, n)) => (d, Some(n)),
        None => ("", user),
    };
    let line = |t: &str| format!("{t}\n");
    match &asked[given] {
        // Asked again after the password went in: the server refused it.
        Prompt::User(_) | Prompt::Domain | Prompt::Password if asked[..given].contains(&Prompt::Password) => Err("The server did not accept that user name or password".into()),
        Prompt::User(default) => name.map(line).ok_or_else(|| format!("auth:user:{default}")),
        Prompt::Domain => Ok(line(domain)), // empty = the default gio offers
        Prompt::Password => password.map(line).ok_or_else(|| if asked.iter().any(|p| matches!(p, Prompt::User(_))) { "auth:user:".to_string() } else { "auth:password".to_string() }),
        Prompt::Choice if trust => Ok(line("1")),
        Prompt::Choice => {
            // The question is everything before its numbered answers.
            let q = out.split("\n[1]").next().unwrap_or("").lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" ");
            Err(format!("trust:{}", if q.is_empty() { "The server's identity could not be checked." } else { q.as_str() }))
        }
    }
}

/// Mounts a network address (or a plugged-in phone) through gvfs and returns the folder it shows up as.
/// `user` / `password` are only given once gio asked for them (see `answer`).
/// shortcut: gio does not flush its prompts into a pipe, so this starts it once per prompt, each time with one more
/// answer on stdin (nothing is sent to the server before the password is known). Talk to gvfs' mount operation
/// over D-Bus instead if those extra starts ever feel slow. A server that does not answer makes this wait as long as gvfs waits.
pub fn connect(address: &str, user: Option<&str>, password: Option<&str>, trust: bool) -> R<String> {
    let uri = check_address(address)?;
    let mut answers = String::new();
    for given in 0..8 {
        let (ok, out, err) = run("gio", &["mount", uri], &answers)?;
        if ok || err.contains("already mounted") {
            // "local path: /run/user/1000/gvfs/…"
            let (_, info, _) = run("gio", &["info", uri], "")?;
            return info.lines().find_map(|l| l.trim().strip_prefix("local path: ")).map(str::to_string).ok_or_else(|| "Connected, but it has no folder to open (is gvfs-fuse running?)".into());
        }
        let asked = prompts(&out);
        if asked.len() <= given {
            return Err(plain(&err));
        }
        answers += &answer(&asked, given, user, password, trust, &out)?;
    }
    Err("The server kept asking questions; nothing was connected".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_table_is_parsed_and_network_mounts_told_apart() {
        let table = "/dev/sdb1 /run/media/m/My\\040Stick exfat rw 0 0\n//nas/docs /mnt/nas cifs rw 0 0\ngdrive: /home/m/GoogleDrive fuse.rclone rw 0 0\n\
                     gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0\nportal /run/user/1000/doc fuse.portal rw 0 0\ninode /tmp/.mount_inodeAb fuse.inode ro 0 0\nm@box:/srv /home/m/box fuse.sshfs rw 0 0\n";
        let m = parse_mounts(table);
        assert_eq!(m[0].dir, "/run/media/m/My Stick");
        assert_eq!(m.iter().filter(|m| is_network(m)).map(|m| m.dir.as_str()).collect::<Vec<_>>(), ["/mnt/nas", "/home/m/GoogleDrive", "/home/m/box"]);
        assert_eq!(unescape("a\\134b\\011c\\9"), "a\\b\tc\\9");
    }

    #[test]
    fn gvfs_folders_get_readable_names() {
        let name = |d| gvfs_name(d);
        assert_eq!(name("smb-share:server=nas,share=docs"), ("smb".into(), "docs on nas".into(), "nas".into()));
        assert_eq!(name("sftp:host=box,user=matt"), ("sftp".into(), "matt@box (sftp)".into(), "box".into()));
        assert_eq!(name("mtp:host=Google_Pixel_6_1A2B"), ("mtp".into(), "Google Pixel 6 1A2B".into(), "Google_Pixel_6_1A2B".into()));
        assert_eq!(name("dav:host=cloud.example,ssl=true").1, "cloud.example (dav)");
    }

    #[test]
    fn plugged_in_phones_and_locked_drives_are_found() {
        let gio = "Drive(0): Stick\n  Type: GProxyDrive\n  Volume(0): Coding Work\n    Type: GProxyVolume\n    uuid=64A5\n    can_mount=0\n    Mount(0): Coding Work -> file:///run/media/m/x\n\
                   Volume(0): Pixel 6\n  Type: GProxyVolume (GProxyVolumeMonitorMTP)\n  ids:\n   unix-device: '/dev/bus/usb/001/012'\n  activation_root=mtp://Google_Pixel_6_1A2B/\n  can_mount=1\n";
        assert_eq!(parse_volumes(gio), [("Pixel 6".to_string(), "mtp://Google_Pixel_6_1A2B/".to_string())]);
        let lsblk = r#"{"blockdevices": [
            {"path":"/dev/sdb1","kname":"sdb1","pkname":"sdb","fstype":"crypto_LUKS","label":null,"size":"58G"},
            {"path":"/dev/sdc1","kname":"sdc1","pkname":"sdc","fstype":"crypto_LUKS","label":"Vault","size":"1G"},
            {"path":"/dev/nvme0n1p2","kname":"nvme0n1p2","pkname":"nvme0n1","fstype":"crypto_LUKS","label":null,"size":"952G"},
            {"path":"/dev/mapper/root","kname":"dm-0","pkname":"nvme0n1p2","fstype":"btrfs","label":null,"size":"952G"}]}"#;
        assert_eq!(parse_locked(lsblk), [("/dev/sdb1".to_string(), "58G encrypted drive".to_string()), ("/dev/sdc1".to_string(), "Vault".to_string())]);
        assert!(parse_locked("not json").is_empty());
    }

    #[test]
    fn an_unlocked_volume_names_the_partition_under_it() {
        let sys = std::env::temp_dir().join(format!("inode-sys-{}", std::process::id()));
        std::fs::create_dir_all(sys.join("dm-3/dm")).unwrap();
        std::fs::create_dir_all(sys.join("dm-3/slaves/sdb1")).unwrap();
        std::fs::create_dir_all(sys.join("dm-4/dm")).unwrap();
        std::fs::write(sys.join("dm-3/dm/uuid"), "CRYPT-LUKS2-abc-luks-abc\n").unwrap();
        std::fs::write(sys.join("dm-4/dm/uuid"), "LVM-xyz\n").unwrap();
        assert_eq!(luks_parent(&sys, "/dev/dm-3").as_deref(), Some("/dev/sdb1"));
        assert_eq!(luks_parent(&sys, "/dev/dm-4"), None);
        assert_eq!(luks_parent(&sys, "/dev/sdb1"), None);
        std::fs::remove_dir_all(&sys).unwrap();
    }

    #[test]
    fn addresses_are_checked_before_gio_sees_them() {
        assert_eq!(check_address(" smb://nas/docs "), Ok("smb://nas/docs"));
        assert_eq!(check_address("SFTP://matt@box:2222/srv/a%20b"), Ok("SFTP://matt@box:2222/srv/a%20b"));
        assert_eq!(check_address("mtp://%5Busb%3A001,012%5D/"), Ok("mtp://%5Busb%3A001,012%5D/"));
        for bad in ["nas/docs", "--help", "file:///etc", "http://example.com", "smb://", "smb:///share", "smb://nas/my docs", "smb://nas/a\nb", "ftp://matt:secret@box/"] {
            assert!(check_address(bad).is_err(), "{bad}");
        }
        assert!(!check_address("ftp://matt:secret@box/").unwrap_err().contains("secret"));
    }

    #[test]
    fn gio_prompts_are_answered_one_at_a_time() {
        let out = "Authentication Required\nEnter user and password for share “docs” on “nas”:\nUser [matt]: Domain [WORKGROUP]: Password: ";
        let asked = prompts(out);
        assert_eq!(asked, [Prompt::User("matt".into()), Prompt::Domain, Prompt::Password]);
        assert_eq!(prompts("Password required for share docs on nas\nPassword: "), [Prompt::Password]);
        // Nothing known yet: the UI is told to ask, with gio's default user name.
        assert_eq!(answer(&asked[..1], 0, None, None, false, out), Err("auth:user:matt".into()));
        assert_eq!(answer(&[Prompt::Password], 0, None, None, false, ""), Err("auth:password".into()));
        assert_eq!(answer(&asked, 0, Some("CORP\\kim"), Some("pw"), false, out), Ok("kim\n".into()));
        assert_eq!(answer(&asked, 1, Some("CORP\\kim"), Some("pw"), false, out), Ok("CORP\n".into()));
        assert_eq!(answer(&asked, 1, Some("kim"), Some("pw"), false, out), Ok("\n".into()));
        assert_eq!(answer(&asked, 2, Some("kim"), Some("pw"), false, out), Ok("pw\n".into()));
        // Asked again after the password: refused, and the message does not repeat the password.
        let again = prompts(&format!("{out}{out}"));
        assert_eq!(answer(&again, 3, Some("kim"), Some("pw"), false, out), Err("The server did not accept that user name or password".into()));
        // An unknown host key is the user's call.
        let q = "Can’t verify the identity of “box”.\nThis happens when you log in to a computer the first time.\n\n[1] Log In Anyway\n[2] Cancel Login\nChoice: ";
        assert_eq!(prompts(q), [Prompt::Choice]);
        assert!(answer(&[Prompt::Choice], 0, None, None, false, q).unwrap_err().starts_with("trust:Can’t verify the identity of “box”. This happens"));
        assert_eq!(answer(&[Prompt::Choice], 0, None, None, true, q), Ok("1\n".into()));
    }

    #[test]
    fn locked_folder_recovery_key_is_found_and_open_ones_are_not_network() {
        let out = "Password: \n2a6c4f1e0b9d3c775e8a1f20c4d6b8e971f0a3b29d5c8e640f1a2b3c4d5e6f70\n";
        assert_eq!(recovery_key(out).as_deref(), Some("2a6c4f1e-0b9d3c77-5e8a1f20-c4d6b8e9-71f0a3b2-9d5c8e64-0f1a2b3c-4d5e6f70"));
        assert_eq!(recovery_key("no key here\n2a6c-zz"), None);
        let m = parse_mounts("/home/m/Private /run/user/1000/inode-locked/Private fuse.gocryptfs rw 0 0\n");
        assert!(!is_network(&m[0]));
    }

    #[test]
    fn tool_errors_lose_their_lead_in() {
        assert_eq!(plain("gio: smb://nas/docs/: Failed to mount Windows share: Connection refused\n"), "Failed to mount Windows share: Connection refused");
        assert_eq!(plain("Error unlocking /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.Failed: Error unlocking /dev/sdb1: Failed to activate device: Incorrect passphrase"), "Incorrect passphrase");
        assert_eq!(plain("fusermount3: entry for /x not found in /etc/mtab"), "fusermount3: entry for /x not found in /etc/mtab");
    }
}
