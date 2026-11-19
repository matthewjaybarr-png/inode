//! Files on the system clipboard, so cut, copy and paste work with other file managers and apps.
//! The UI builds and reads the payloads (util.js: toUriList, fromUris); this only moves them.

type R<T> = Result<T, String>;

/// Of the types a Wayland clipboard offers, the one that carries files: GNOME's first (it says cut or copy).
#[cfg(any(not(windows), test))]
fn file_type(offered: &str) -> Option<&'static str> {
    ["x-special/gnome-copied-files", "text/uri-list"].into_iter().find(|t| offered.lines().any(|l| l.trim() == *t))
}

/// wl-copy offers one type per run, so it is text/uri-list: every file manager, browser and chat app pastes files
/// from it, while x-special/gnome-copied-files is read by GNOME-style file managers only. The price: other apps
/// see a Cut as a copy (inside Inode it stays a cut).
/// shortcut: one clipboard type, so no cut flag for other apps; offer both from an own Wayland data source
/// (wl-clipboard-rs) if moving by cut and paste into Nautilus is wanted.
#[cfg(not(windows))]
pub fn write(_paths: &[String], uris: &str) -> R<()> {
    use std::{io::Write, os::unix::process::CommandExt, process::Stdio};
    // Its own process group and no pipes left open: wl-copy forks a holder that keeps serving the clipboard after
    // this returns, and after Inode quits. The parent exits once the clipboard is set, so wait() is short.
    let mut child = crate::fs::clean(std::process::Command::new("wl-copy"))
        .args(["--type", "text/uri-list"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("wl-copy: {e}"))?;
    let sent = child.stdin.take().unwrap().write_all(uris.as_bytes());
    let ok = child.wait().map_err(|e| e.to_string())?.success();
    if ok && sent.is_ok() { Ok(()) } else { Err("wl-copy could not set the clipboard".into()) }
}

/// The clipboard's file payload ("" when it holds no files); Err when there is no wl-paste to ask.
#[cfg(not(windows))]
pub fn read() -> R<String> {
    // An empty clipboard makes wl-paste fail with no output, which reads as "no files".
    let paste = |args: &[&str]| {
        crate::fs::clean(std::process::Command::new("wl-paste")).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).map_err(|e| format!("wl-paste: {e}"))
    };
    match file_type(&paste(&["--list-types"])?) {
        Some(t) => paste(&["--no-newline", "--type", t]),
        None => Ok(String::new()),
    }
}

/// Runs a fixed script in a hidden Windows PowerShell. Paths never go into the script text: they ride in an
/// environment variable (UTF-16, nothing to escape), one per line.
#[cfg(windows)]
fn powershell(script: &str, paths: &str) -> R<String> {
    use std::os::windows::process::CommandExt;
    let o = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("INODE_CLIP", paths)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| e.to_string())?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into_owned()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
}

// shortcut: Set-Clipboard cannot set "Preferred DropEffect", so a Cut from Inode pasted into Explorer behaves as a
// copy (inside Inode it stays a cut), and a selection whose paths pass 32,767 characters (one environment variable)
// stays in-app only. Upgrade: the OLE clipboard (CF_HDROP + Preferred DropEffect) through the `windows` crate.
#[cfg(windows)]
pub fn write(paths: &[String], _uris: &str) -> R<()> {
    powershell("Set-Clipboard -LiteralPath ($env:INODE_CLIP -split [char]10) -ErrorAction Stop", &paths.join("\n")).map(|_| ())
}

/// One percent-encoded (so plain ASCII, whatever the console code page) file: URI per copied file.
#[cfg(windows)]
pub fn read() -> R<String> {
    powershell("Get-Clipboard -Format FileDropList | ForEach-Object { 'file:' + [uri]::EscapeDataString($_.FullName.Replace('\\', '/')) }", "")
}

#[cfg(test)]
mod tests {
    #[test]
    fn picks_the_type_that_carries_files() {
        assert_eq!(super::file_type("text/plain\ntext/uri-list\nx-special/gnome-copied-files\n"), Some("x-special/gnome-copied-files"));
        assert_eq!(super::file_type("TEXT\r\ntext/uri-list\r\n"), Some("text/uri-list"));
        assert_eq!(super::file_type("text/plain\ntext/html\n"), None);
        assert_eq!(super::file_type(""), None);
    }
}
