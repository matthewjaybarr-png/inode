//! Custom actions: the user's own commands in the right-click menu, one TOML file each, in omanta's format so
//! its files work here unchanged. Later folders win by file name: Inode's own folder over omanta's user folder
//! over what omanta ships. The UI decides which actions fit a selection (util.js actionsFor); this file reads
//! them and runs them, always as an argument vector.
use crate::fs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

type R<T> = Result<T, String>;

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct Action {
    /// The file name without .toml.
    #[serde(skip_deserializing)]
    pub id: String,
    pub name: String,
    /// The name when several items are selected; %n = how many.
    pub plural: String,
    /// %f / %F = the selected paths, each its own argument.
    pub command: String,
    /// Run the command once per item instead of once with all of them.
    pub each: bool,
    pub terminal: bool,
    /// Programs that must be on PATH, or the action is left out.
    #[serde(skip_serializing)]
    pub requires: Vec<String>,
    pub mimetypes: Vec<String>,
    pub extensions: Vec<String>,
    pub directories: bool,
    /// Only for items inside these folders (a leading ~ is the home folder; expanded on load).
    pub under: Vec<String>,
    /// One setting: the chosen value reaches the command as OMANTA_OPTION_<OPTION>.
    pub option: String,
    pub option_label: String,
    /// "value=Label" (or just "value"); the first is the default.
    pub option_choices: Vec<String>,
}

impl Default for Action {
    fn default() -> Self {
        let (s, v) = (String::new, Vec::new);
        Action { id: s(), name: s(), plural: s(), command: s(), each: false, terminal: false, requires: v(), mimetypes: v(), extensions: v(), directories: true, under: v(), option: s(), option_label: s(), option_choices: v() }
    }
}

/// One action file; None when it is not valid TOML or has no name or command (an all-comment file: the example).
pub fn parse(text: &str, home: &str) -> Option<Action> {
    let mut a: Action = toml::from_str(text).ok()?;
    if a.name.trim().is_empty() || split(&a.command).is_empty() {
        return None;
    }
    for u in &mut a.under {
        if let Some(rest) = u.strip_prefix('~').filter(|r| r.is_empty() || r.starts_with(['/', '\\'])) {
            *u = format!("{home}{rest}");
        }
    }
    // The option becomes an environment variable name; a malformed one drops the option, not the action.
    a.option_choices.retain(|c| !value_of(c).is_empty());
    if a.option.is_empty() || !a.option.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') || a.option_choices.is_empty() {
        a.option.clear();
        a.option_choices.clear();
    }
    Some(a)
}

fn value_of(choice: &str) -> &str {
    choice.split('=').next().unwrap_or_default().trim()
}

/// Inode's own actions folder.
pub fn own_dir() -> Option<PathBuf> {
    crate::tags::config_dir().map(|d| d.join("actions"))
}

fn home() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()
}

fn dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(target_os = "linux") && !cfg!(test) {
        v.push(PathBuf::from("/usr/share/omanta/actions"));
        v.push(Path::new(&home()).join(".config/omanta/actions"));
    }
    v.extend(own_dir());
    v
}

/// Every usable action of these folders, in file-name order. A file in a later folder replaces the one of the
/// same name before it, even when it is not a usable action itself: that is how to switch a shipped one off.
pub fn load_from(dirs: &[PathBuf], home: &str) -> Vec<Action> {
    let mut by_id = std::collections::BTreeMap::new();
    for de in dirs.iter().filter_map(|d| std::fs::read_dir(d).ok()).flat_map(|rd| rd.flatten()) {
        let p = de.path();
        if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("toml")) {
            let id = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            let a = std::fs::read_to_string(&p).ok().and_then(|t| parse(&t, home)).map(|a| Action { id: id.clone(), ..a });
            by_id.insert(id, a);
        }
    }
    by_id.into_values().flatten().filter(|a| a.requires.iter().all(|r| on_path(r).is_some())).collect()
}

pub fn load() -> Vec<Action> {
    load_from(&dirs(), &home())
}

const EXAMPLE: &str = r##"# An Inode custom action: one .toml file per action in this folder (omanta's format).
# Remove the leading "# " from the lines you need, save, then use "Reload actions" in Settings
# (switching back to the Inode window reloads them too). It then shows in the right-click menu
# and the command palette for the items it fits.
#
# name = "Open in my editor"            # the menu text (required)
# plural = "Open %n items in my editor" # the text when several are selected; %n = how many
# command = "my-editor --new-window %F" # required. %F = every selected path, %f = one path;
#                                       # each path is handed over as one argument, spaces and all
# each = true                           # run the command once per item
# terminal = true                       # run it in a terminal window
# requires = ["my-editor"]              # hide the action unless these programs are on PATH
# extensions = [".txt", ".md"]          # only for these file types...
# mimetypes = ["text/*", "image/*"]     # ...or these kinds (image/*, video/*, audio/*, text/*)
# directories = false                   # not for folders
# under = ["~/Documents"]               # only inside these folders
# option = "mode"                       # one setting, chosen in Settings; the command gets it
# option_label = "Mode"                 # as the environment variable OMANTA_OPTION_MODE
# option_choices = ["fast=Fast", "best=Best quality"]   # value=Label; the first is the default
"##;

/// The own actions folder, made on first use with one commented example in it.
pub fn folder() -> R<String> {
    let d = own_dir().ok_or("no config folder")?;
    std::fs::create_dir_all(&d).map_err(|e| format!("Cannot create {}: {e}", fs::s(&d)))?;
    if std::fs::read_dir(&d).map_err(|e| e.to_string())?.next().is_none() {
        std::fs::write(d.join("example.toml"), EXAMPLE).map_err(|e| e.to_string())?;
    }
    Ok(fs::s(&d))
}

/// A program by name on PATH (Windows: also name.exe / .cmd / .bat / .com), or a path to one.
pub fn on_path(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd", ".bat", ".com"] } else { &[""] };
    let dirs: Vec<PathBuf> = if name.contains(['/', '\\']) { vec![PathBuf::new()] } else { std::env::split_paths(&std::env::var_os("PATH")?).collect() };
    dirs.iter().flat_map(|d| exts.iter().map(move |x| d.join(format!("{name}{x}")))).find(|p| p.is_file())
}

/// Splits a command line the way a shell words it: blanks separate, '…' and "…" keep blanks, and (not on
/// Windows, where \ is the path separator) a backslash keeps the next character. Nothing else is special:
/// no variables, no globs, no pipes.
pub fn split(cmd: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote, mut open) = (Vec::new(), String::new(), None, false);
    let mut it = cmd.chars();
    while let Some(c) = it.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => (quote, open) = (Some(c), true),
            (q, '\\') if !cfg!(windows) && q != Some('\'') => {
                cur.extend(it.next());
                open = true;
            }
            (None, c) if c.is_whitespace() => {
                if open || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                open = false;
            }
            (_, c) => cur.push(c),
        }
    }
    if open || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// One argument vector per process to start: the command's words, with a `%f` or `%F` word replaced by the
/// paths, each as its own argument (`each`: one path per run). A path is never re-read as words.
pub fn invocations(a: &Action, paths: &[String]) -> Vec<Vec<String>> {
    let words = split(&a.command);
    let batches: Vec<&[String]> = if a.each { paths.chunks(1).collect() } else { vec![paths] };
    batches.iter().map(|b| words.iter().flat_map(|w| if w == "%f" || w == "%F" { b.to_vec() } else { vec![w.clone()] }).collect()).collect()
}

/// The option's variable and value: `chosen` when it is one of the choices, else the first.
fn option_env(a: &Action, chosen: Option<&str>) -> Option<(String, String)> {
    let first = value_of(a.option_choices.first()?);
    let v = chosen.filter(|c| a.option_choices.iter().any(|x| value_of(x) == *c)).unwrap_or(first);
    Some((format!("OMANTA_OPTION_{}", a.option.to_uppercase()), v.to_string()))
}

/// One terminal for all the runs, one after the other. Every word is a positional parameter of this fixed
/// script (`run` keeps the first $1 of its arguments and runs them), so no file name is ever shell text.
#[cfg(not(windows))]
const IN_TERMINAL: &str = r#"cd "$1" || exit 1; n=$2; shift 2
run() { k=$1; shift; i=0; for a do shift; [ "$i" -lt "$k" ] && set -- "$@" "$a"; i=$((i+1)); done; "$@"; }
while [ "$#" -gt 0 ]; do run "$n" "$@" || echo "[exit code $?]"; shift "$n"; done
printf '\nDone. Press Enter to close. '; read -r _ || :"#;

#[cfg(not(windows))]
fn terminal_args(dir: &str, runs: &[Vec<String>]) -> Vec<String> {
    let mut v: Vec<String> = ["sh", "-c", IN_TERMINAL, "sh", dir].map(String::from).to_vec();
    v.push(runs[0].len().to_string()); // every run has the same number of words
    v.extend(runs.iter().flatten().cloned());
    v
}

/// Runs action `id` on `paths` in folder `dir` and waits for it. Ok = what to say in the status bar;
/// Err = it could not start, or which exit code it gave.
pub fn run(id: &str, paths: &[String], dir: &str, option: Option<&str>) -> R<String> {
    let a = load().into_iter().find(|a| a.id == id).ok_or("That action is no longer there: Reload actions in Settings")?;
    let env = option_env(&a, option);
    #[allow(unused_mut)] // only the Linux terminal branch changes it
    let mut runs = invocations(&a, paths);
    if runs.is_empty() {
        return Err("Nothing selected to run it on".into());
    }
    #[cfg(not(windows))]
    if a.terminal {
        // Set with env(1) in the command line itself: a single-instance terminal would not pass our environment on.
        if let Some((k, v)) = &env {
            for r in &mut runs {
                r.splice(0..0, ["env".to_string(), format!("{k}={v}")]);
            }
        }
        fs::terminal(dir, Some(terminal_args(dir, &runs)))?;
        return Ok(format!("{}: started in a terminal", a.name));
    }
    let start = |argv: &Vec<String>| {
        let mut c = fs::clean(std::process::Command::new(on_path(&argv[0]).unwrap_or_else(|| PathBuf::from(&argv[0]))));
        c.args(&argv[1..]).current_dir(dir).envs(env.clone()).stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            // shortcut: a terminal action gets a console window of its own (no shell in between), which closes when
            // the program ends; wrap it in a terminal that stays open if its last output must be readable.
            use std::os::windows::process::CommandExt;
            c.creation_flags(if a.terminal { 0x10 } else { 0x0800_0000 }); // CREATE_NEW_CONSOLE / CREATE_NO_WINDOW
        }
        c.spawn().map_err(|e| format!("{}: cannot start {}: {e}", a.name, argv[0]))
    };
    // All at once (a viewer per file should not wait for the one before); a Windows console action takes turns.
    let mut failed = Vec::new();
    let mut wait = |kid: R<std::process::Child>| match kid.and_then(|mut k| k.wait().map_err(|e| e.to_string())) {
        Ok(st) if st.success() => {}
        Ok(st) => failed.push(st.code().map_or("it was stopped".to_string(), |c| format!("exit code {c}"))),
        Err(e) => failed.push(e),
    };
    if cfg!(windows) && a.terminal {
        runs.iter().for_each(|r| wait(start(r)));
    } else {
        runs.iter().map(start).collect::<Vec<_>>().into_iter().for_each(&mut wait);
    }
    match failed.len() {
        0 => Ok(format!("{}: done", a.name)),
        n => Err(format!("{} failed{}: {}", a.name, if runs.len() > 1 { format!(" for {n} of {}", runs.len()) } else { String::new() }, failed[0])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// /usr/share/omanta/actions/transcode.toml of omanta 0.1.32, as shipped.
    const TRANSCODE: &str = r#"# Omarchy's Transcode, as omarchy-transcode ships it: images and video only,
# never folders, one floating presentation terminal chaining the files.
name = "Transcode"
plural = "Transcode %n items"
command = "omarchy-transcode %f"
each = true
terminal = true
requires = ["omarchy-transcode"]
mimetypes = ["image/*", "video/*"]
extensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".avif", ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]
directories = false
"#;
    /// dropbox-copy-link.toml (the `under` key) and omanta's examples/actions/resolve-audio.toml (the option keys).
    const DROPBOX: &str = "name = \"Copy Dropbox Link\"\nplural = \"Copy %n Dropbox Links\"\ncommand = \"omanta-dropbox-link copy %f\"\neach = true\nrequires = [\"omanta-dropbox-link\", \"socat\", \"wl-copy\"]\nunder = [\"~/Dropbox\"]\n";
    const RESOLVE: &str = "name = \"Convert Audio for Resolve\"\ncommand = \"omanta-resolve-audio %f\"\neach = true\nterminal = true\nmimetypes = [\"video/*\"]\ndirectories = false\n\noption = \"codec\"\noption_label = \"Audio Codec\"\noption_choices = [\"pcm16=PCM 16-bit\", \"pcm24=PCM 24-bit\", \"mp3=MP3 320 kbps\"]\n";

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn omanta_files_parse_unchanged() {
        let t = parse(TRANSCODE, "/home/u").unwrap();
        assert_eq!((t.name.as_str(), t.plural.as_str(), t.command.as_str()), ("Transcode", "Transcode %n items", "omarchy-transcode %f"));
        assert!(t.each && t.terminal && !t.directories && t.option.is_empty());
        assert_eq!(t.requires, ["omarchy-transcode"]);
        assert_eq!(t.mimetypes, ["image/*", "video/*"]);
        assert_eq!(t.extensions.len(), 13);
        let d = parse(DROPBOX, "/home/u").unwrap();
        assert!(d.directories && !d.terminal);
        assert_eq!(d.under, ["/home/u/Dropbox"]);
        let r = parse(RESOLVE, "/home/u").unwrap();
        assert_eq!(option_env(&r, None), Some(("OMANTA_OPTION_CODEC".into(), "pcm16".into())));
        assert_eq!(option_env(&r, Some("mp3")), Some(("OMANTA_OPTION_CODEC".into(), "mp3".into())));
        assert_eq!(option_env(&r, Some("nope")).unwrap().1, "pcm16");
        // Not an action: the commented example, a file with no command, broken TOML. A bad option name only drops the option.
        assert_eq!(parse(EXAMPLE, ""), None);
        assert_eq!(parse("name = \"x\"\n", ""), None);
        assert_eq!(parse("name = \n", ""), None);
        assert!(parse("name = \"x\"\ncommand = \"y\"\noption = \"a b\"\noption_choices = [\"1\"]\nsomething_new = 3\n", "").unwrap().option.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn command_lines_split_like_shell_words() {
        assert_eq!(split(r#"convert  -resize "50 %" 'it''s a "b"' c\ d "" %f"#), ["convert", "-resize", "50 %", "its a \"b\"", "c d", "", "%f"]);
        assert_eq!(split(r#"sh -c 'echo "$1"' x "a\"b""#), ["sh", "-c", "echo \"$1\"", "x", "a\"b"]);
        assert!(split("   ").is_empty());
    }

    #[test]
    fn paths_stay_whole_arguments() {
        let paths = strs(&["/tmp/a b/it's \"x\".txt", "/tmp/$(rm -rf ~);`x`.png"]);
        let all = Action { command: "send --to 'my phone' %F --quiet".into(), ..Default::default() };
        assert_eq!(invocations(&all, &paths), [strs(&["send", "--to", "my phone", &paths[0], &paths[1], "--quiet"])]);
        let each = Action { command: "transcode %f".into(), each: true, ..Default::default() };
        assert_eq!(invocations(&each, &paths), [strs(&["transcode", &paths[0]]), strs(&["transcode", &paths[1]])]);
    }

    #[test]
    fn user_files_override_shipped_ones_and_requires_hides() {
        let d = std::env::temp_dir().join(format!("inode-actions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (sys, user) = (d.join("sys"), d.join("user"));
        for x in [&sys, &user] {
            std::fs::create_dir_all(x).unwrap();
        }
        let file = |name: &str, requires: &str| format!("name = \"{name}\"\ncommand = \"true %F\"\nrequires = [{requires}]\n");
        std::fs::write(sys.join("b.toml"), file("shipped b", "")).unwrap();
        std::fs::write(sys.join("a.toml"), file("shipped a", "")).unwrap();
        std::fs::write(sys.join("off.toml"), file("switched off", "")).unwrap();
        std::fs::write(sys.join("needs.toml"), file("needs", "\"no-such-program-inode-test\"")).unwrap();
        std::fs::write(sys.join("notes.txt"), "not an action").unwrap();
        std::fs::write(user.join("b.toml"), file("my b", "")).unwrap();
        std::fs::write(user.join("off.toml"), "# name = \"switched off\"\n").unwrap();
        let got = load_from(&[sys, d.join("missing"), user], "");
        assert_eq!(got.iter().map(|a| (a.id.as_str(), a.name.as_str())).collect::<Vec<_>>(), [("a", "shipped a"), ("b", "my b")]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// The terminal script, run without a terminal: every run gets exactly its own words, whatever is in the names.
    #[cfg(unix)]
    #[test]
    fn terminal_script_runs_each_invocation_with_whole_paths() {
        let d = std::env::temp_dir().join(format!("inode-term-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let dir = d.to_string_lossy().into_owned();
        let paths = strs(&["a b.txt", "it's \"q\" $(touch pwned).txt", "-c.txt"]);
        let a = Action { command: "touch -- %f".into(), each: true, ..Default::default() };
        let args = terminal_args(&dir, &invocations(&a, &paths));
        let st = std::process::Command::new(&args[0]).args(&args[1..]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).status().unwrap();
        assert!(st.success());
        let mut made: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        made.sort();
        assert_eq!(made, ["-c.txt", "a b.txt", "it's \"q\" $(touch pwned).txt"]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// folder() and run() under cfg!(test) use the throwaway config folder, never the user's.
    #[cfg(unix)]
    #[test]
    fn folder_gets_an_example_and_run_reports_the_exit_code() {
        let d = PathBuf::from(folder().unwrap());
        assert!(d.starts_with(std::env::temp_dir()) && d.join("example.toml").is_file());
        assert!(load().is_empty());
        std::fs::write(d.join("ok.toml"), "name = \"Ok\"\ncommand = \"sh -c 'test -f \\\"$1\\\"' x %f\"\neach = true\n").unwrap();
        std::fs::write(d.join("opt.toml"), "name = \"Opt\"\ncommand = \"sh -c 'test \\\"$OMANTA_OPTION_MODE\\\" = best'\"\noption = \"mode\"\noption_choices = [\"fast=Fast\", \"best\"]\n").unwrap();
        let dir = d.to_string_lossy().into_owned();
        let here = |n: &str| d.join(n).to_string_lossy().into_owned();
        assert_eq!(run("ok", &[here("ok.toml"), here("opt.toml")], &dir, None).unwrap(), "Ok: done");
        assert_eq!(run("ok", &[here("ok.toml"), here("no such file")], &dir, None).unwrap_err(), "Ok failed for 1 of 2: exit code 1");
        assert!(run("opt", &[], &dir, Some("best")).is_ok());
        assert_eq!(run("opt", &[], &dir, None).unwrap_err(), "Opt failed: exit code 1");
        assert!(run("gone", &[], &dir, None).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
