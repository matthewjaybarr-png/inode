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

/// What Explorer shows for a file (its thumbnail, else its icon) as a data URL, at most `size` pixels a side.
/// Linux: None for now.
#[tauri::command]
pub async fn thumb(path: String, size: i32) -> Option<String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let (w, h, px) = win::thumb(&path, size.clamp(16, 1024))?;
        Some(format!("data:image/bmp;base64,{}", base64::engine::general_purpose::STANDARD.encode(bmp(w, h, px))))
    })
    .await
    .ok()
    .flatten();
    #[cfg(not(windows))]
    {
        let _ = (path, size);
        None
    }
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
