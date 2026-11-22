//! Files on the system clipboard, so cut, copy and paste work with other file managers and apps.
//! The UI builds and reads the payloads (util.js: toUriList, fromUris); this only moves them.

type R<T> = Result<T, String>;

/// Of the types a Wayland clipboard offers, the one that carries files: GNOME's first (it says cut or copy).
#[cfg(any(not(windows), test))]
fn file_type(offered: &str) -> Option<&'static str> {
    ["x-special/gnome-copied-files", "text/uri-list"].into_iter().find(|t| offered.lines().any(|l| l.trim() == *t))
}

/// Wayland sessions use wl-clipboard; X11 sessions (no WAYLAND_DISPLAY) use xclip.
#[cfg(not(windows))]
fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
}

/// wl-copy and xclip offer one type per run, so it is text/uri-list: every file manager, browser and chat app pastes
/// files from it, while x-special/gnome-copied-files is read by GNOME-style file managers only. The price: other apps
/// see a Cut as a copy (inside Inode it stays a cut).
/// shortcut: one clipboard type, so no cut flag for other apps; offer both from an own Wayland data source
/// (wl-clipboard-rs) if moving by cut and paste into Nautilus is wanted.
#[cfg(not(windows))]
pub fn write(_paths: &[String], uris: &str, _mv: bool) -> R<()> {
    use std::{io::Write, os::unix::process::CommandExt, process::Stdio};
    let (prog, args): (&str, &[&str]) =
        if wayland() { ("wl-copy", &["--type", "text/uri-list"]) } else { ("xclip", &["-selection", "clipboard", "-t", "text/uri-list", "-i"]) };
    // Its own process group and no pipes left open: wl-copy and xclip fork a holder that keeps serving the clipboard
    // after this returns, and after Inode quits. The parent exits once the clipboard is set, so wait() is short.
    let mut child = crate::fs::clean(std::process::Command::new(prog))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("{prog}: {e}"))?;
    let sent = child.stdin.take().unwrap().write_all(uris.as_bytes());
    let ok = child.wait().map_err(|e| e.to_string())?.success();
    if ok && sent.is_ok() { Ok(()) } else { Err(format!("{prog} could not set the clipboard")) }
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
    fn picks_the_type_that_carries_files() {
        assert_eq!(super::file_type("text/plain\ntext/uri-list\nx-special/gnome-copied-files\n"), Some("x-special/gnome-copied-files"));
        assert_eq!(super::file_type("TEXT\r\ntext/uri-list\r\n"), Some("text/uri-list"));
        assert_eq!(super::file_type("text/plain\ntext/html\n"), None);
        assert_eq!(super::file_type(""), None);
    }
}
