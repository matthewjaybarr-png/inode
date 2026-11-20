//! Colour tags: one JSON file (path -> colour) in the config folder, read and written whole, so every window
//! shares it. ops.rs calls the hooks below wherever it moves or removes an item, so the map follows.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const COLOURS: [&str; 7] = ["red", "orange", "yellow", "green", "blue", "purple", "grey"];
/// A trashed item's tag waits under this prefix + its original path until the item is restored or purged.
// shortcut: a stashed tag whose item was purged by another app (or the desktop's "empty trash") stays in the
// file, unseen; sweep the stash against the trash listing if the file ever grows.
const STASH: &str = "trash:";

pub type Map = BTreeMap<String, String>;
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Inode's own config folder (the one choice.rs keeps the theme in). Tests get a throwaway one, never the user's.
pub(crate) fn config_dir() -> Option<PathBuf> {
    if cfg!(test) {
        return Some(std::env::temp_dir().join(format!("inode-config-test-{}", std::process::id())));
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.map(|b| b.join("inode"))
}

fn read(f: &Path) -> Map {
    std::fs::read(f).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Reads the map, lets `f` change it, and writes it back only when it did change: to a temp file first, then
/// renamed over the old one, so a crash can never leave half a file.
fn change(f: impl FnOnce(&mut Map)) -> Map {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = config_dir().map(|d| d.join("tags.json")) else { return Map::new() };
    let mut m = read(&file);
    let was = m.clone();
    f(&mut m);
    if m != was {
        let tmp = file.with_extension("json.tmp");
        let done = std::fs::create_dir_all(file.parent().unwrap()).and_then(|_| std::fs::write(&tmp, serde_json::to_vec(&m).unwrap_or_default())).and_then(|_| std::fs::rename(&tmp, &file));
        if let Err(e) = done {
            eprintln!("inode: could not save the tags: {e}");
        }
    }
    m
}

/// `k` is `root` itself or something inside it.
fn within(k: &str, root: &str) -> bool {
    k.strip_prefix(root).is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '\\']))
}

fn drop_tree(m: &mut Map, path: &str) {
    m.retain(|k, _| !within(k, path));
}

/// `from` (and, for a folder, everything tagged inside it) now lives at `to`; whatever `to` held is gone.
fn rekey(m: &mut Map, from: &str, to: &str) {
    if from == to {
        return;
    }
    drop_tree(m, to);
    for k in m.keys().filter(|k| within(k, from)).cloned().collect::<Vec<_>>() {
        let v = m.remove(&k).unwrap();
        m.insert(format!("{to}{}", &k[from.len()..]), v);
    }
}

/// What the UI sees: the stash stays out.
fn shown(m: Map) -> Map {
    m.into_iter().filter(|(k, _)| !k.starts_with(STASH)).collect()
}

// The hooks. Each is a no-op (one small read) when nothing tagged is involved.
pub fn moved(from: &str, to: &str) {
    change(|m| rekey(m, from, to));
}
pub fn removed(path: &str) {
    change(|m| drop_tree(m, path));
}
pub fn trashed(path: &str, original: &str) {
    moved(path, &format!("{STASH}{original}"));
}
pub fn restored(original: &str, to: &str) {
    moved(&format!("{STASH}{original}"), to);
}
pub fn purged(original: &str) {
    removed(&format!("{STASH}{original}"));
}

/// Tags (`colour`) or untags (None) the paths; returns the whole map.
pub fn set(paths: &[String], colour: Option<&str>) -> Result<Map, String> {
    if let Some(c) = colour.filter(|c| !COLOURS.contains(c)) {
        return Err(format!("Not a tag colour: {c}"));
    }
    Ok(shown(change(|m| {
        for p in paths.iter().filter(|p| !p.starts_with(STASH)) {
            match colour {
                Some(c) => m.insert(p.clone(), c.into()),
                None => m.remove(p),
            };
        }
    })))
}

/// The whole map. Listing a folder passes it as `dir`: tags on items that are no longer in it are dropped
/// then (something outside Inode moved or deleted them). A folder that cannot be read drops nothing.
pub fn all(dir: Option<&str>) -> Map {
    let dir = dir.map(Path::new).filter(|d| d.is_dir());
    shown(change(|m| {
        if let Some(d) = dir {
            m.retain(|k, _| Path::new(k).parent() != Some(d) || Path::new(k).symlink_metadata().is_ok());
        }
    }))
}

/// Every path tagged `colour`.
pub fn paths(colour: &str) -> Vec<String> {
    all(None).into_iter().filter(|(_, c)| c == colour).map(|(p, _)| p).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> Map {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn rename_move_and_delete_keep_the_map_in_step() {
        let mut m = map(&[("/a/one.txt", "red"), ("/a/dir", "blue"), ("/a/dir/in.txt", "green"), ("/a/dir2/x", "grey"), ("/b/one.txt", "yellow")]);
        // A rename; a folder takes what is tagged inside it along, and "dir2" is not inside "dir".
        rekey(&mut m, "/a/one.txt", "/a/two.txt");
        rekey(&mut m, "/a/dir", "/c/moved");
        assert_eq!(m, map(&[("/a/dir2/x", "grey"), ("/a/two.txt", "red"), ("/b/one.txt", "yellow"), ("/c/moved", "blue"), ("/c/moved/in.txt", "green")]));
        // A move that replaces a tagged item: the old tag there goes, even when the newcomer has none.
        rekey(&mut m, "/a/two.txt", "/b/one.txt");
        rekey(&mut m, "/a/plain", "/a/dir2/x");
        assert_eq!(m, map(&[("/b/one.txt", "red"), ("/c/moved", "blue"), ("/c/moved/in.txt", "green")]));
        // A delete takes the folder's tag and those inside it.
        drop_tree(&mut m, "/c/moved");
        assert_eq!(m, map(&[("/b/one.txt", "red")]));
        // Windows separators work the same way.
        let mut w = map(&[("C:\\a\\dir\\f.txt", "red")]);
        rekey(&mut w, "C:\\a\\dir", "C:\\a\\new");
        assert_eq!(w, map(&[("C:\\a\\new\\f.txt", "red")]));
    }

    /// Through the file (a throwaway config folder under cfg!(test)); own paths, so parallel tests cannot clash.
    #[test]
    fn file_round_trip_trash_stash_and_lazy_drop() {
        let d = std::env::temp_dir().join(format!("inode-tags-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = |n: &str| d.join(n).to_string_lossy().into_owned();
        std::fs::write(p("keep.txt"), "").unwrap();
        assert!(set(&[p("keep.txt")], Some("pink")).is_err());
        set(&[p("keep.txt"), p("gone.txt"), p("bin.txt")], Some("red")).unwrap();
        assert_eq!(paths("red").iter().filter(|x| x.starts_with(&p(""))).count(), 3);
        // Trashed: out of sight but kept; restored under another name: the tag follows.
        trashed(&p("bin.txt"), &p("bin.txt"));
        assert!(!all(None).contains_key(&p("bin.txt")));
        restored(&p("bin.txt"), &p("bin (2).txt"));
        assert_eq!(all(None).get(&p("bin (2).txt")).map(String::as_str), Some("red"));
        // Listing the folder drops the tags of what is not there any more.
        let m = all(Some(&d.to_string_lossy()));
        assert!(m.contains_key(&p("keep.txt")) && !m.contains_key(&p("gone.txt")) && !m.contains_key(&p("bin (2).txt")));
        assert!(set(&[p("keep.txt")], None).unwrap().get(&p("keep.txt")).is_none());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
