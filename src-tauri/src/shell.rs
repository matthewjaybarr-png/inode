//! Working with the desktop's own shell: shortcuts, thumbnails, and dragging files out to other apps.
//! Windows does these through COM (`win` below); Linux needs a symlink at most.
use std::path::Path;

type R<T> = Result<T, String>;

/// Makes "<name> - Shortcut.lnk" (Windows) or a symlink "Link to <name>" (Linux) beside the item; a taken name
/// gets " (2)". Returns the new path.
#[tauri::command]
pub async fn make_link(path: String) -> R<String> {
    let p = Path::new(&path);
    let (dir, name) = p.parent().zip(p.file_name()).ok_or("A drive cannot have a shortcut beside it")?;
    let name = if cfg!(windows) { format!("{} - Shortcut.lnk", name.to_string_lossy()) } else { format!("Link to {}", name.to_string_lossy()) };
    // A Linux link to a folder is named like a folder ("Link to a.b (2)"); a .lnk is always a file.
    let link = if dir.join(&name).symlink_metadata().is_ok() { crate::ops::free_name(dir, &name, !cfg!(windows) && p.is_dir()) } else { dir.join(&name) };
    #[cfg(windows)]
    win::make_lnk(p, &link)?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(p, &link).map_err(|e| format!("Cannot create {}: {e}", link.display()))?;
    Ok(crate::fs::s(&link))
}

/// The folder a Windows shortcut (.lnk) points to, so opening it can stay in Inode; None for anything else.
#[tauri::command]
pub async fn link_dir(path: String) -> Option<String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || win::lnk_targets(&[path]).pop().flatten().filter(|t| Path::new(t).is_dir())).await.ok().flatten();
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// A picture for a file as a data URL, at most `size` pixels a side. Windows: what Explorer shows (its thumbnail,
/// else its icon). Linux: the desktop's cached thumbnail when there is a fresh one, else None (none are made here).
#[tauri::command]
pub async fn thumb(path: String, size: i32) -> Option<String> {
    use base64::Engine;
    let b64 = |kind: &str, bytes: Vec<u8>| format!("data:image/{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
    #[cfg(windows)]
    let job = move || {
        let (w, h, px) = win::thumb(&path, size.clamp(16, 1024))?;
        Some(b64("bmp", bmp(w, h, px)))
    };
    #[cfg(not(windows))]
    let job = move || {
        let cache = std::env::var_os("XDG_CACHE_HOME").map(std::path::PathBuf::from).or_else(|| Some(Path::new(&std::env::var_os("HOME")?).join(".cache")))?;
        Some(b64("png", std::fs::read(cached_thumb(&cache.join("thumbnails"), Path::new(&path), size)?).ok()?))
    };
    tauri::async_runtime::spawn_blocking(job).await.ok().flatten()
}

/// The freedesktop thumbnail of `file` under `dir` (~/.cache/thumbnails): <size dir>/<md5 of the file's URI>.png,
/// the size nearest to the one asked for first, and only one written after the file last changed.
#[cfg(any(not(windows), test))]
fn cached_thumb(dir: &Path, file: &Path, size: i32) -> Option<std::path::PathBuf> {
    let changed = file.metadata().ok()?.modified().ok()?;
    let name = format!("{}.png", md5_hex(thumb_uri(&file.to_string_lossy()).as_bytes()));
    let sizes = if size > 128 { ["large", "normal"] } else { ["normal", "large"] };
    sizes.iter().map(|s| dir.join(s).join(&name)).find(|p| p.metadata().and_then(|m| m.modified()).is_ok_and(|t| t > changed))
}

/// The file:// URI thumbnailers hash: the path as GLib escapes it (letters, digits and -._~!$&'()*+,;=:@/ stay).
#[cfg(any(not(windows), test))]
fn thumb_uri(path: &str) -> String {
    let mut uri = String::from("file://");
    for &b in path.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

/// MD5 as lower-case hex (RFC 1321), only to name thumbnail cache files; no crate in the tree has it.
#[cfg(any(not(windows), test))]
fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 16] = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    let mut h: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend((data.len() as u64 * 8).to_le_bytes());
    for block in msg.chunks_exact(64) {
        let m: Vec<u32> = block.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let [mut a, mut b, mut c, mut d] = h;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let k = ((i as f64 + 1.0).sin().abs() * 4_294_967_296.0) as u32;
            let sum = a.wrapping_add(f).wrapping_add(k).wrapping_add(m[g]);
            (a, d, c) = (d, c, b);
            b = b.wrapping_add(sum.rotate_left(S[i / 16 * 4 + i % 4]));
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().flat_map(|x| x.to_le_bytes()).map(|b| format!("{b:02x}")).collect()
}

/// Starts a real OS drag of these files from the window (Windows; rows dragged past the window's edge, see
/// dnd.js). Resolves when the drag ends, dropped or not.
#[tauri::command]
pub async fn drag_out(window: tauri::Window, paths: Vec<String>) -> R<()> {
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        // OLE drag and drop belongs to the thread that owns the window.
        window
            .run_on_main_thread(move || {
                let _ = tx.send(win::drag(&paths));
            })
            .map_err(|e| e.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = (window, paths);
        Ok(())
    }
}

/// A .bmp file from top-down BGRA pixels with premultiplied alpha (what the Windows shell hands out). The header
/// is the V4 one with an alpha mask, so the webview keeps an icon's transparency; no image crate needed.
#[cfg(any(windows, test))]
fn bmp(w: i32, h: i32, mut px: Vec<u8>) -> Vec<u8> {
    if px.chunks_exact(4).all(|p| p[3] == 0) {
        px.chunks_exact_mut(4).for_each(|p| p[3] = 255); // the picture has no alpha at all: it is opaque
    }
    for p in px.chunks_exact_mut(4).filter(|p| p[3] > 0 && p[3] < 255) {
        let a = p[3] as u32;
        p[..3].iter_mut().for_each(|c| *c = (*c as u32 * 255 / a).min(255) as u8); // a .bmp's alpha is not premultiplied
    }
    const HEAD: u32 = 14 + 108;
    let mut out = Vec::with_capacity(HEAD as usize + px.len());
    out.extend(b"BM");
    for v in [HEAD + px.len() as u32, 0, HEAD] {
        out.extend(v.to_le_bytes());
    }
    // BITMAPV4HEADER: size, width, height (negative = top-down), planes 1 + 32 bits, BI_BITFIELDS, image bytes,
    // 72 dpi twice, no palette (2 fields), the red, green, blue and alpha masks, then the sRGB colour space.
    for v in [108, w as u32, -h as u32, 1 | 32 << 16, 3, px.len() as u32, 2835, 2835, 0, 0, 0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000, 0x7352_4742] {
        out.extend(v.to_le_bytes());
    }
    out.resize(HEAD as usize, 0); // colour endpoints and gamma: unused with sRGB
    out.extend(px);
    out
}

#[cfg(windows)]
pub mod win {
    use super::R;
    use std::path::Path;
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Foundation::{E_FAIL, SIZE};
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IDataObject, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ};
    use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{BHID_DataObject, ILCreateFromPathW, ILFree, IShellItemImageFactory, IShellLinkW, SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists, SHDoDragDrop, ShellLink, SIIGBF_RESIZETOFIT};

    /// Runs `f` with COM ready on this (worker) thread.
    fn com<T>(f: impl FnOnce() -> windows::core::Result<T>) -> R<T> {
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let r = f().map_err(|e| e.message());
            if init.is_ok() {
                CoUninitialize();
            }
            r
        }
    }

    /// Where each .lnk points (None: unreadable, or not a file or folder), all in one COM session.
    pub fn lnk_targets(lnks: &[String]) -> Vec<Option<String>> {
        let one = |lnk: &String| unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk), STGM_READ).ok()?;
            let mut buf = [0u16; 1024];
            link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
            let end = buf.iter().position(|&c| c == 0)?;
            (end > 0).then(|| String::from_utf16_lossy(&buf[..end]))
        };
        com(|| Ok(lnks.iter().map(one).collect())).unwrap_or_default()
    }

    pub fn make_lnk(target: &Path, lnk: &Path) -> R<()> {
        com(|| unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(target))?;
            link.cast::<IPersistFile>()?.Save(&HSTRING::from(lnk), true)
        })
        .map_err(|e| format!("Cannot create {}: {e}", lnk.display()))
    }

    /// (width, height, top-down premultiplied BGRA) of the shell's picture for a file: thumbnail, else icon.
    pub fn thumb(path: &str, size: i32) -> Option<(i32, i32, Vec<u8>)> {
        com(|| unsafe {
            let item: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path), None)?;
            let hbm = item.GetImage(SIZE { cx: size, cy: size }, SIIGBF_RESIZETOFIT)?;
            let mut bm = BITMAP::default();
            GetObjectW(hbm.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut BITMAP as *mut _));
            let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
            let mut info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, ..Default::default() }, ..Default::default() };
            let mut px = vec![0u8; (w.max(0) as usize) * (h as usize) * 4];
            let dc = GetDC(None);
            let rows = GetDIBits(dc, hbm, 0, h as u32, Some(px.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            let _ = DeleteObject(hbm.into());
            if rows > 0 && rows == h { Ok((w, h, px)) } else { Err(E_FAIL.into()) }
        })
        .ok()
    }

    /// A real OS drag of these files, so Explorer, the desktop or another app can take them; returns when it ends.
    // The shell supplies the data object, the drop source and the drag image, and the target picks copy, move or
    // link like any Explorer drag. The `drag` crate was the other route: it offers one effect per drag, needs an
    // image file, and pulls in two more versions of the `windows` crate.
    pub fn drag(paths: &[String]) -> R<()> {
        unsafe {
            let ids: Vec<*const ITEMIDLIST> = paths.iter().map(|p| ILCreateFromPathW(&HSTRING::from(p)) as *const ITEMIDLIST).filter(|id| !id.is_null()).collect();
            let r = SHCreateShellItemArrayFromIDLists(&ids)
                .and_then(|items| items.BindToHandler::<_, IDataObject>(None, &BHID_DataObject))
                .and_then(|data| SHDoDragDrop(None, &data, None, DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK));
            ids.iter().for_each(|&id| ILFree(Some(id)));
            r.map(|_| ()).map_err(|e| e.message())
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn bmp_has_a_v4_header_and_plain_alpha() {
        // 2 x 1: a half-transparent premultiplied pixel, then an opaque one.
        let b = super::bmp(2, 1, vec![64, 0, 128, 128, 1, 2, 3, 255]);
        assert_eq!((&b[..2], b.len(), u32::from_le_bytes(b[2..6].try_into().unwrap())), (&b"BM"[..], 122 + 8, 130));
        assert_eq!((u32::from_le_bytes(b[10..14].try_into().unwrap()), u32::from_le_bytes(b[14..18].try_into().unwrap())), (122, 108));
        assert_eq!((i32::from_le_bytes(b[18..22].try_into().unwrap()), i32::from_le_bytes(b[22..26].try_into().unwrap()), b[28]), (2, -1, 32));
        assert_eq!(&b[122..], [127, 0, 255, 128, 1, 2, 3, 255]);
        // No alpha anywhere means an opaque picture, not an invisible one.
        assert_eq!(&super::bmp(1, 1, vec![9, 8, 7, 0])[122..], [9, 8, 7, 255]);
    }

    #[test]
    fn md5_and_thumbnail_names_match_the_spec() {
        assert_eq!(super::md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(super::md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(super::md5_hex(b"12345678901234567890123456789012345678901234567890123456789012345678901234567890"), "57edf4a22be3c955ac49da2e2107b67a");
        // The example in the freedesktop thumbnail spec.
        assert_eq!(super::md5_hex(super::thumb_uri("/home/jens/photos/me.png").as_bytes()), "c6ee772d9e49320e97ec29a7eb5b1697");
        assert_eq!(super::thumb_uri("/a b/\u{e9}#(1).png"), "file:///a%20b/%C3%A9%23(1).png");
    }

    #[cfg(unix)]
    #[test]
    fn cached_thumbnail_must_be_newer_than_the_file() {
        let d = std::env::temp_dir().join(format!("inode-thumb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("cache/large")).unwrap();
        std::fs::create_dir_all(d.join("cache/normal")).unwrap();
        let file = d.join("clip.mp4");
        let name = |f: &std::path::Path| format!("{}.png", super::md5_hex(super::thumb_uri(&f.to_string_lossy()).as_bytes()));
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        let stamp = |f: &std::path::Path, t| std::fs::File::options().write(true).open(f).unwrap().set_modified(t).unwrap();
        std::fs::write(&file, "x").unwrap();
        assert_eq!(super::cached_thumb(&d.join("cache"), &file, 256), None);
        let large = d.join("cache/large").join(name(&file));
        std::fs::write(&large, "png").unwrap();
        stamp(&file, old);
        assert_eq!(super::cached_thumb(&d.join("cache"), &file, 256), Some(large.clone()));
        assert_eq!(super::cached_thumb(&d.join("cache"), &file, 96), Some(large.clone())); // no "normal" one: the large one does
        stamp(&large, old - std::time::Duration::from_secs(60));
        assert_eq!(super::cached_thumb(&d.join("cache"), &file, 256), None); // the file changed after the thumbnail was made
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn link_is_made_beside_the_item_and_never_over_a_name() {
        let d = std::env::temp_dir().join(format!("inode-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("my.dir")).unwrap();
        std::fs::write(d.join("a.txt"), "x").unwrap();
        let make = |n: &str| tauri::async_runtime::block_on(super::make_link(crate::fs::s(&d.join(n)))).unwrap();
        assert_eq!(make("a.txt"), crate::fs::s(&d.join("Link to a.txt")));
        assert_eq!(make("a.txt"), crate::fs::s(&d.join("Link to a (2).txt")));
        assert_eq!(std::fs::read_to_string(d.join("Link to a (2).txt")).unwrap(), "x");
        assert_eq!((make("my.dir"), make("my.dir")), (crate::fs::s(&d.join("Link to my.dir")), crate::fs::s(&d.join("Link to my.dir (2)"))));
        assert!(tauri::async_runtime::block_on(super::make_link("/".into())).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
