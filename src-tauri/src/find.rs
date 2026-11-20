//! Content search: the files under a folder whose text holds the query, each once, with its first matching
//! line and how many matches it has. ripgrep does it when it is installed; otherwise the walker below.
use crate::fs::{self, Entry, SEARCH_GEN};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::SeqCst;

type R<T> = Result<T, String>;

const MAX_FILE: u64 = 5 * 1024 * 1024;

#[derive(Serialize, Debug, Default)]
pub struct Hits {
    pub entries: Vec<Entry>,
    /// Per entry: [first matching line, number of matches].
    pub notes: Vec<(String, u64)>,
    /// Stopped at the limit; there may be more.
    pub truncated: bool,
}

/// The running ripgrep, so a newer search (or leaving the folder) can stop it mid-read.
static RG: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

/// Stops a running ripgrep. fs::search calls it too, so anything that supersedes a search ends it.
pub fn stop() {
    if let Some(mut c) = RG.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn clip(line: &str) -> String {
    line.trim().chars().take(200).collect()
}

/// Files under `root` containing `query`. Hidden files and folders only when `hidden` is on; binary files and
/// files over 5 MB are skipped. `rg` = the ripgrep to use (None: the built-in walker). A newer search stops this one.
pub fn search_text(root: &str, query: &str, hidden: bool, case: bool, limit: usize, rg: Option<PathBuf>) -> R<Hits> {
    let gen = SEARCH_GEN.fetch_add(1, SeqCst) + 1;
    stop();
    if query.is_empty() {
        return Ok(Hits::default());
    }
    std::fs::read_dir(root).map_err(|e| format!("Cannot open {root}: {e}"))?;
    match rg {
        Some(bin) => ripgrep(&bin, root, query, hidden, case, limit, gen),
        None => walk(root, query, hidden, case, limit, gen),
    }
}

/// An argument vector, never a shell: the query and the folder are plain arguments after `--`.
fn ripgrep(bin: &Path, root: &str, query: &str, hidden: bool, case: bool, limit: usize, gen: u64) -> R<Hits> {
    use std::io::BufRead;
    let mut c = fs::clean(std::process::Command::new(bin));
    // --no-ignore: a file manager finds what is there, whatever .gitignore says; --no-config: not the user's own rg flags.
    c.args(["--json", "--fixed-strings", "--no-config", "--no-ignore", "--no-messages", "--max-filesize", "5M"]);
    if !case {
        c.arg("--ignore-case");
    }
    if hidden {
        c.arg("--hidden");
    }
    c.arg("--").arg(query).arg(root).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = c.spawn().map_err(|e| format!("Cannot start ripgrep: {e}"))?;
    let out = child.stdout.take().ok_or("ripgrep gave no output")?;
    *RG.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    let mut hits = Hits::default();
    let mut first = None;
    for line in std::io::BufReader::new(out).split(b'\n').map_while(Result::ok) {
        if SEARCH_GEN.load(SeqCst) != gen {
            return Err("superseded".into()); // whoever superseded us already stopped the child
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
        let d = &v["data"];
        match v["type"].as_str() {
            Some("begin") => first = None,
            Some("match") if first.is_none() => first = d["lines"]["text"].as_str().map(clip),
            Some("end") => {
                // binary_offset: ripgrep met a NUL byte, so this is not text.
                let (Some(path), Some(line), true) = (d["path"]["text"].as_str(), first.take(), d["binary_offset"].is_null()) else { continue };
                if hits.entries.len() == limit {
                    hits.truncated = true;
                    break;
                }
                if let Some(e) = fs::entry_of(Path::new(path)) {
                    hits.entries.push(e);
                    hits.notes.push((line, d["stats"]["matches"].as_u64().unwrap_or(1)));
                }
            }
            _ => {}
        }
    }
    if SEARCH_GEN.load(SeqCst) != gen {
        return Err("superseded".into());
    }
    stop(); // ours still: done or at the limit
    Ok(hits)
}

/// The built-in search: regular files only (links are not followed), nearest folders first.
// shortcut: reads each file whole (at most 5 MB) and knows UTF-8 only, so UTF-16 text counts as binary;
// ripgrep handles both, install it where that matters.
fn walk(root: &str, query: &str, hidden: bool, case: bool, limit: usize, gen: u64) -> R<Hits> {
    use std::io::Read;
    let q = if case { query.to_string() } else { query.to_lowercase() };
    let mut hits = Hits::default();
    let mut todo = std::collections::VecDeque::from([PathBuf::from(root)]);
    while let Some(dir) = todo.pop_front() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for de in rd.flatten() {
            if SEARCH_GEN.load(SeqCst) != gen {
                return Err("superseded".into());
            }
            let Some((e, real_dir)) = fs::entry(&de) else { continue };
            if e.hidden && !hidden {
                continue;
            }
            if real_dir {
                todo.push_back(de.path());
            }
            if !de.file_type().is_ok_and(|t| t.is_file()) || e.size > MAX_FILE {
                continue;
            }
            let mut buf = Vec::new();
            if std::fs::File::open(de.path()).and_then(|f| f.take(MAX_FILE).read_to_end(&mut buf)).is_err() || buf[..buf.len().min(8192)].contains(&0) {
                continue;
            }
            let (mut count, mut first) = (0u64, None);
            for l in String::from_utf8_lossy(&buf).lines() {
                let n = if case { l.matches(&q).count() } else { l.to_lowercase().matches(&q).count() };
                if n > 0 {
                    count += n as u64;
                    first.get_or_insert_with(|| clip(l));
                }
            }
            if let Some(line) = first {
                if hits.entries.len() == limit {
                    hits.truncated = true;
                    return Ok(hits);
                }
                hits.entries.push(e);
                hits.notes.push((line, count));
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same checks for the walker and, where it is installed, ripgrep.
    #[test]
    fn finds_text_once_per_file_skips_binary_and_hidden_and_caps() {
        let _turn = fs::search_tests::TURN.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("inode-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub dir")).unwrap();
        std::fs::create_dir_all(root.join(".hid")).unwrap();
        std::fs::write(root.join("a.txt"), "nothing here\n  first Needle line\nneedle and needle again\n").unwrap();
        std::fs::write(root.join("sub dir/b's.md"), "one needle\n").unwrap();
        std::fs::write(root.join("none.txt"), "hay only\n").unwrap();
        std::fs::write(root.join("bin.dat"), b"\0\0needle\0\0needle\n").unwrap();
        std::fs::write(root.join(".hid/c.txt"), "needle\n").unwrap();
        let big = std::fs::File::create(root.join("big.log")).unwrap();
        std::io::Write::write_all(&mut &big, b"needle\n").unwrap();
        big.set_len(MAX_FILE + 1).unwrap();
        let r = root.to_string_lossy();
        let mut engines = vec![None];
        engines.extend(crate::actions::on_path("rg").map(Some));
        for rg in engines {
            let which = if rg.is_some() { "rg" } else { "walker" };
            let got = |hidden, case, limit| {
                let h = search_text(&r, "needle", hidden, case, limit, rg.clone()).unwrap();
                let mut v: Vec<_> = h.entries.iter().zip(&h.notes).map(|(e, n)| (e.name.clone(), n.0.clone(), n.1)).collect();
                v.sort();
                (v, h.truncated)
            };
            let row = |n: &str, l: &str, c| (n.to_string(), l.to_string(), c);
            assert_eq!(got(false, false, 50), (vec![row("a.txt", "first Needle line", 3), row("b's.md", "one needle", 1)], false), "{which}");
            assert_eq!(got(false, true, 50).0[0], row("a.txt", "needle and needle again", 2), "{which}: match case");
            assert_eq!(got(true, false, 50).0.len(), 3, "{which}: hidden on");
            let (one, capped) = got(false, false, 1);
            assert!(capped && one.len() == 1, "{which}: cap");
            assert!(search_text(&r, "", false, false, 50, rg.clone()).unwrap().entries.is_empty());
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
