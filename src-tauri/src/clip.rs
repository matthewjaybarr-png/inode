//! Files on the system clipboard, so cut, copy and paste work with other file managers and apps.
//! The UI builds and reads the payloads (util.js: toUriList, fromUris); this only moves them.

type R<T> = Result<T, String>;

/// Of the types a clipboard offers, the one that carries files: GNOME's or MATE's first (they say cut or copy).
#[cfg(any(not(windows), test))]
fn file_type(offered: &str) -> Option<&'static str> {
    ["x-special/gnome-copied-files", "x-special/mate-copied-files", "text/uri-list"].into_iter().find(|t| offered.lines().any(|l| l.trim() == *t))
}

/// Wayland sessions use wl-clipboard; X11 sessions (no WAYLAND_DISPLAY) use xclip.
#[cfg(not(windows))]
fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
}

/// Offers the file types: text/uri-list (every file manager, browser and chat app), x-special/gnome-copied-files
/// (Nautilus, Nemo, Thunar: its first line says cut or copy) and the same payload as x-special/mate-copied-files
/// (Caja, MATE's fork, reads only that name). X11 and Wayland clipboards are served by the
/// process that set them, so a detached copy of Inode (`--clip-hold`) holds them, and they outlive this window the
/// way wl-copy's and xclip's did.
#[cfg(not(windows))]
pub fn write(_paths: &[String], uris: &str, mv: bool) -> R<()> {
    use std::{io::{BufRead, Write}, os::unix::process::CommandExt, process::Stdio};
    // An AppImage runs from a temporary mount that goes when this window quits; APPIMAGE is the file itself.
    let exe = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from).or_else(|| std::env::current_exe().ok()).ok_or("cannot tell where inode is")?;
    let mut child = crate::fs::clean(std::process::Command::new(exe))
        .arg("--clip-hold")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0) // not killed with Inode's group
        .spawn()
        .map_err(|e| format!("clipboard holder: {e}"))?;
    let verb = if mv { "cut" } else { "copy" };
    let sent = child.stdin.take().unwrap().write_all(format!("{verb}\n{uris}").as_bytes()); // dropped = EOF
    let mut said = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut said).ok();
    std::thread::spawn(move || child.wait()); // it lives on until another app takes the clipboard; reap it then
    match said.trim_end() {
        "ok" if sent.is_ok() => Ok(()),
        "" => Err("the clipboard holder stopped".into()),
        e => Err(e.to_string()),
    }
}

/// The two payloads from the holder's input ("cut" or "copy", then the text/uri-list): (uri-list, gnome-copied-files).
#[cfg(any(not(windows), test))]
fn payloads(input: &str) -> (String, String) {
    let (verb, uris) = input.split_once('\n').unwrap_or(("copy", input));
    let lines: Vec<&str> = uris.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    (uris.to_string(), format!("{verb}\n{}", lines.join("\n")))
}

/// `inode --clip-hold`: what write() sends on stdin goes on the clipboard; "ok" (or the error) on stdout, then it
/// serves it until another app sets the clipboard. Wayland first (needs the data-control protocol, which GNOME
/// lacks), then X11 (on GNOME that is XWayland, which hands the clipboard on to Wayland apps). Returns the exit code.
#[cfg(not(windows))]
pub fn hold() -> i32 {
    use std::io::{Read, Write};
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let (uris, gnome) = payloads(&input);
    let offers = [
        ("text/uri-list", uris.into_bytes()),
        ("x-special/gnome-copied-files", gnome.clone().into_bytes()),
        ("x-special/mate-copied-files", gnome.into_bytes()),
    ];
    let say = |m: &str| {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{m}").and_then(|_| out.flush());
    };
    let wl = if wayland() { wayland_hold(&offers) } else { Err("no Wayland".into()) };
    let held = match wl {
        Ok(copy) => {
            say("ok");
            copy.serve().map_err(|e| e.to_string())
        }
        Err(wl_err) => match x11_hold(&offers) {
            Ok(x) => {
                say("ok");
                x11_serve(x, &offers)
            }
            Err(x_err) => {
                say(&format!("clipboard: {wl_err}; {x_err}"));
                return 1;
            }
        },
    };
    held.map_or(1, |_| 0)
}

#[cfg(not(windows))]
fn wayland_hold(offers: &[(&str, Vec<u8>)]) -> R<wl_clipboard_rs::copy::PreparedCopy> {
    use wl_clipboard_rs::copy::{MimeSource, MimeType, Options, Source};
    let sources = offers.iter().map(|(t, b)| MimeSource { source: Source::Bytes(b.clone().into()), mime_type: MimeType::Specific(t.to_string()) }).collect();
    let mut o = Options::new();
    o.foreground(true); // serve() runs here, in the holder, rather than forking again
    o.prepare_copy_multi(sources).map_err(|e| format!("Wayland: {e}"))
}

#[cfg(not(windows))]
struct X11 {
    conn: x11rb::rust_connection::RustConnection,
    clipboard: u32,
    targets: u32,
    atoms: Vec<u32>, // one per offer, same order
}

/// Takes the X11 CLIPBOARD with a hidden window of our own.
#[cfg(not(windows))]
fn x11_hold(offers: &[(&str, Vec<u8>)]) -> R<X11> {
    use x11rb::{connection::Connection, protocol::xproto::*, wrapper::ConnectionExt as _, COPY_DEPTH_FROM_PARENT, CURRENT_TIME};
    let e = |e: &dyn std::fmt::Display| format!("X11: {e}");
    let (conn, screen) = x11rb::connect(None).map_err(|x| e(&x))?;
    let root = conn.setup().roots[screen].root;
    let win = conn.generate_id().map_err(|x| e(&x))?;
    conn.create_window(COPY_DEPTH_FROM_PARENT, win, root, 0, 0, 1, 1, 0, WindowClass::INPUT_ONLY, 0, &Default::default()).map_err(|x| e(&x))?;
    let atom = |n: &str| conn.intern_atom(false, n.as_bytes()).map_err(|x| e(&x))?.reply().map(|r| r.atom).map_err(|x| e(&x));
    let (clipboard, targets) = (atom("CLIPBOARD")?, atom("TARGETS")?);
    let atoms = offers.iter().map(|(t, _)| atom(t)).collect::<R<Vec<_>>>()?;
    conn.set_selection_owner(win, clipboard, CURRENT_TIME).map_err(|x| e(&x))?;
    let owner = conn.get_selection_owner(clipboard).map_err(|x| e(&x))?.reply().map_err(|x| e(&x))?.owner;
    if owner != win {
        return Err("X11: another app kept the clipboard".into());
    }
    conn.sync().map_err(|x| e(&x))?;
    Ok(X11 { conn, clipboard, targets, atoms })
}

/// Answers paste requests until another app takes the clipboard (SelectionClear).
/// shortcut: each payload goes in one property, no INCR transfer; fine below the server's request limit (16 MB
/// with BIG-REQUESTS, about 60,000 files), chunk it if a bigger selection is ever copied.
#[cfg(not(windows))]
fn x11_serve(x: X11, offers: &[(&str, Vec<u8>)]) -> R<()> {
    use x11rb::{connection::Connection, protocol::{xproto::*, Event}, wrapper::ConnectionExt as _, NONE};
    loop {
        match x.conn.wait_for_event().map_err(|e| e.to_string())? {
            Event::SelectionClear(c) if c.selection == x.clipboard => return Ok(()),
            Event::SelectionRequest(r) => {
                // An old-style request with no property means: use the target as the property.
                let prop = if r.property == NONE { r.target } else { r.property };
                let done = if r.target == x.targets {
                    let mut list = x.atoms.clone();
                    list.push(x.targets);
                    x.conn.change_property32(PropMode::REPLACE, r.requestor, prop, AtomEnum::ATOM, &list).is_ok()
                } else if let Some(i) = x.atoms.iter().position(|a| *a == r.target) {
                    x.conn.change_property8(PropMode::REPLACE, r.requestor, prop, r.target, &offers[i].1).is_ok()
                } else {
                    false
                };
                let ev = SelectionNotifyEvent { response_type: SELECTION_NOTIFY_EVENT, sequence: 0, time: r.time, requestor: r.requestor, selection: r.selection, target: r.target, property: if done { prop } else { NONE } };
                let _ = x.conn.send_event(false, r.requestor, EventMask::NO_EVENT, ev);
                let _ = x.conn.flush();
            }
            _ => {}
        }
    }
}

/// The clipboard's file payload ("" when it holds no files); Err when there is no wl-paste / xclip to ask.
#[cfg(not(windows))]
pub fn read() -> R<String> {
    let prog = if wayland() { "wl-paste" } else { "xclip" };
    // An empty clipboard makes wl-paste / xclip fail with no output, which reads as "no files".
    let paste = |args: &[&str]| {
        crate::fs::clean(std::process::Command::new(prog)).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).map_err(|e| format!("{prog}: {e}"))
    };
    let types = if wayland() { paste(&["--list-types"])? } else { paste(&["-selection", "clipboard", "-t", "TARGETS", "-o"])? };
    match file_type(&types) {
        Some(t) if wayland() => paste(&["--no-newline", "--type", t]),
        Some(t) => paste(&["-selection", "clipboard", "-t", t, "-o"]),
        None => Ok(String::new()),
    }
}

/// Runs a fixed script in a hidden Windows PowerShell. Paths never go into the script text: they ride in an
/// environment variable (UTF-16, nothing to escape), one per line.
#[cfg(windows)]
fn powershell(script: &str, paths: &str) -> R<String> {
    use std::os::windows::process::CommandExt;
    let o = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script]) // the clipboard needs an STA thread
        .env("INODE_CLIP", paths)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| e.to_string())?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into_owned()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
}

// The file list (CF_HDROP) plus "Preferred DropEffect" (2 = move, 5 = copy), which is how Explorer tells a cut
// from a copy. SetDataObject(.., $true) leaves the data on the clipboard after this PowerShell exits.
// shortcut: a selection whose paths pass 32,767 characters (one environment variable) stays in-app only; write
// the OLE clipboard through the `windows` crate if that is ever hit.
#[cfg(windows)]
pub fn write(paths: &[String], _uris: &str, mv: bool) -> R<()> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; $c = New-Object System.Collections.Specialized.StringCollection; \
         $c.AddRange([string[]]($env:INODE_CLIP -split [char]10)); $d = New-Object System.Windows.Forms.DataObject; $d.SetFileDropList($c); \
         $d.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream (,[byte[]]({},0,0,0)))); \
         [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)",
        if mv { 2 } else { 5 }
    );
    powershell(&script, &paths.join("\n")).map(|_| ())
}

/// A first line "cut" when Explorer (or Inode) cut the files, then one percent-encoded (so plain ASCII, whatever
/// the console code page) file: URI per file: the same shape util.js fromUris reads on Linux.
#[cfg(windows)]
pub fn read() -> R<String> {
    powershell(
        "Add-Type -AssemblyName System.Windows.Forms; $d = [System.Windows.Forms.Clipboard]::GetDataObject(); \
         if ($d -and $d.GetDataPresent('FileDrop')) { $e = $d.GetData('Preferred DropEffect'); \
         if ($e -is [System.IO.Stream] -and ($e.ReadByte() -band 2)) { 'cut' }; \
         $d.GetData('FileDrop') | ForEach-Object { 'file:' + [uri]::EscapeDataString($_.Replace('\\', '/')) } }",
        "",
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn makes_both_payloads() {
        let (uris, gnome) = super::payloads("cut\nfile:///a%20b\r\nfile:///c\r\n");
        assert_eq!(uris, "file:///a%20b\r\nfile:///c\r\n");
        assert_eq!(gnome, "cut\nfile:///a%20b\nfile:///c");
    }

    #[test]
    fn picks_the_type_that_carries_files() {
        assert_eq!(super::file_type("text/plain\ntext/uri-list\nx-special/gnome-copied-files\n"), Some("x-special/gnome-copied-files"));
        assert_eq!(super::file_type("text/uri-list\nx-special/mate-copied-files\n"), Some("x-special/mate-copied-files"));
        assert_eq!(super::file_type("TEXT\r\ntext/uri-list\r\n"), Some("text/uri-list"));
        assert_eq!(super::file_type("text/plain\ntext/html\n"), None);
        assert_eq!(super::file_type(""), None);
    }
}
