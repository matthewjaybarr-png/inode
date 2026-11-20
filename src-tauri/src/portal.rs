//! org.freedesktop.impl.portal.FileChooser: other apps' Open and Save dialogs, shown as an Inode window in pick mode.
//! The spec is /usr/share/dbus-1/interfaces/org.freedesktop.impl.portal.FileChooser.xml. xdg-desktop-portal only
//! calls this once `inode --picker on` (setup.rs) has pointed it here.
//!
//! It lives in the same process as FileManager1 (`inode --service`), not a separate `inode --portal`: the app is
//! single-instance, so a second process would only hand its arguments to the running one and exit without ever
//! owning the bus name. Whichever Inode runs first owns both names; D-Bus starts `--service` when none does.
use serde::Serialize;
use std::collections::HashMap;
use tauri::Manager;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub const NAME: &str = "org.freedesktop.impl.portal.desktop.inode";
pub const PATH: &str = "/org/freedesktop/portal/desktop";

type Options = HashMap<String, OwnedValue>;
type Results = HashMap<&'static str, Value<'static>>;
/// A filter as the spec has it: its name, then (0, glob) or (1, mime type) patterns.
type RawFilter = (String, Vec<(u32, String)>);
/// The picker window's answer: the chosen paths and the index of the filter in use. None = cancelled.
pub type Answer = Option<(Vec<String>, usize)>;
pub type Tx = tauri::async_runtime::Sender<Answer>;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Filter {
    name: String,
    /// File-name globs; none = every file fits.
    globs: Vec<String>,
}

/// One OpenFile / SaveFile / SaveFiles call, as the picker window needs it.
#[derive(Serialize, Clone, Debug)]
pub struct Request {
    /// "open", "save" or "saveFiles" (pick the folder for `files`).
    mode: &'static str,
    title: String,
    /// The accept button's text.
    accept: String,
    multiple: bool,
    directory: bool,
    filters: Vec<Filter>,
    /// Index of the filter to start with.
    filter: usize,
    /// Save: the suggested file name.
    name: String,
    /// SaveFiles: the names to be saved into the chosen folder.
    files: Vec<String>,
    #[serde(skip)]
    folder: Option<String>,
    #[serde(skip)]
    select: Option<String>,
    #[serde(skip)]
    raw: Vec<RawFilter>,
}

fn get<T: TryFrom<Value<'static>>>(o: &Options, key: &str) -> Option<T> {
    T::try_from(Value::from(o.get(key)?.try_clone().ok()?)).ok()
}

/// A path option: a byte string with a NUL at the end.
fn bytes(b: Vec<u8>) -> Option<String> {
    let b = b.strip_suffix(&[0]).unwrap_or(&b);
    (!b.is_empty()).then(|| String::from_utf8_lossy(b).into_owned())
}

/// The file-name globs the shared mime database (`db` = /usr/share/mime/globs2, lines of weight:type:glob) lists for
/// a mime type; "image/*" takes every image type.
/// shortcut: aliases and subclasses are not followed; a type with no globs makes its filter show every file.
/// Read the aliases and subclasses files too if a filter ever shows too much.
fn mime_globs(db: &str, mime: &str) -> Vec<String> {
    let family = mime.strip_suffix("/*");
    db.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let mut f = l.splitn(4, ':').skip(1);
            let (kind, glob) = (f.next()?, f.next()?);
            (family.map_or(kind == mime, |fam| kind.split('/').next() == Some(fam))).then(|| glob.to_string())
        })
        .collect()
}

/// Reads the options of a call. Unknown keys and values of the wrong type are skipped, not errors: a sloppy caller
/// still gets a file chooser. `globs_of` turns a mime type into file-name globs.
/// shortcut: `modal` and `choices` are ignored. A Wayland window cannot be made modal to another app's window
/// without the xdg-foreign protocol, and no app asked for choices (extra combo boxes) yet.
pub fn parse(mode: &'static str, title: &str, o: &Options, globs_of: &dyn Fn(&str) -> Vec<String>) -> Request {
    let mut raw: Vec<RawFilter> = get(o, "filters").unwrap_or_default();
    // A current filter that is not in the list is added to it, as the spec says.
    let filter = match get::<RawFilter>(o, "current_filter") {
        Some(c) => raw.iter().position(|f| *f == c).unwrap_or_else(|| {
            raw.push(c);
            raw.len() - 1
        }),
        None => 0,
    };
    let filters = raw
        .iter()
        .map(|(name, patterns)| {
            let (mut globs, mut all) = (Vec::new(), false);
            for (kind, p) in patterns {
                let found = if *kind == 0 { vec![p.clone()] } else { globs_of(p) };
                all |= found.is_empty();
                globs.extend(found);
            }
            Filter { name: name.clone(), globs: if all { Vec::new() } else { globs } }
        })
        .collect();
    let file = get(o, "current_file").and_then(bytes).map(std::path::PathBuf::from);
    let part = |f: fn(&std::path::Path) -> Option<&std::ffi::OsStr>| file.as_deref().and_then(f).map(|n| n.to_string_lossy().into_owned());
    let directory = mode == "saveFiles" || get(o, "directory").unwrap_or(false);
    let accept = match (mode, directory) {
        ("open", false) => "Open",
        ("open", true) => "Choose folder",
        ("saveFiles", _) => "Save here",
        _ => "Save",
    };
    Request {
        mode,
        title: title.to_string(),
        // "_Open": the underscore marks a GTK mnemonic.
        accept: get::<String>(o, "accept_label").map(|l| l.replace('_', "")).filter(|l| !l.trim().is_empty()).unwrap_or_else(|| accept.into()),
        multiple: get(o, "multiple").unwrap_or(false),
        directory,
        filters,
        filter,
        name: get::<String>(o, "current_name").or_else(|| part(|p| p.file_name())).unwrap_or_default(),
        files: get::<Vec<Vec<u8>>>(o, "files").unwrap_or_default().into_iter().filter_map(bytes).collect(),
        folder: get(o, "current_folder").and_then(bytes).or_else(|| part(|p| p.parent().map(|d| d.as_os_str()))),
        select: file.as_deref().map(crate::fs::s),
        raw,
    }
}

/// The results of an accepted call: the paths as file:// URIs, and the filter that was in use.
pub fn reply(req: &Request, paths: &[String], filter: usize) -> Results {
    let uris: Vec<String> = paths.iter().filter_map(|p| tauri::Url::from_file_path(p).ok()).map(String::from).collect();
    let mut r = Results::from([("uris", Value::from(uris))]);
    if let Some(f) = req.raw.get(filter) {
        r.insert("current_filter", Value::from(zbus::zvariant::Structure::from(f.clone())));
    }
    r
}

/// Shows a request to the user, who answers on the channel; the closure it returns takes the picker away again.
pub type Open = Box<dyn Fn(Request, Tx) -> Box<dyn FnOnce() + Send> + Send + Sync>;

pub struct Chooser(pub Open);

/// The Request object of a call in progress: the caller closes it to withdraw the dialog.
struct Call(Tx);

#[zbus::interface(name = "org.freedesktop.impl.portal.Request")]
impl Call {
    async fn close(&self) {
        let _ = self.0.try_send(None);
    }
}

impl Chooser {
    /// Response 0 with results = accepted, 1 = cancelled (the window was closed, Cancel, or the caller withdrew).
    async fn run(&self, server: &zbus::ObjectServer, handle: OwnedObjectPath, mode: &'static str, title: &str, options: &Options) -> (u32, Results) {
        let db = std::fs::read_to_string("/usr/share/mime/globs2").unwrap_or_default();
        let req = parse(mode, title, options, &|mime| mime_globs(&db, mime));
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        let _ = server.at(&handle, Call(tx.clone())).await;
        let close = (self.0)(req.clone(), tx);
        let answer = rx.recv().await.flatten();
        close();
        let _ = server.remove::<Call, _>(&handle).await;
        match answer {
            Some((paths, filter)) => (0, reply(&req, &paths, filter)),
            None => (1, Results::new()),
        }
    }
}

#[allow(unused_variables)] // app_id and parent_window are part of the signature, not of what we do
#[zbus::interface(name = "org.freedesktop.impl.portal.FileChooser")]
impl Chooser {
    async fn open_file(&self, #[zbus(object_server)] server: &zbus::ObjectServer, handle: OwnedObjectPath, app_id: String, parent_window: String, title: String, options: Options) -> (u32, Results) {
        self.run(server, handle, "open", &title, &options).await
    }

    async fn save_file(&self, #[zbus(object_server)] server: &zbus::ObjectServer, handle: OwnedObjectPath, app_id: String, parent_window: String, title: String, options: Options) -> (u32, Results) {
        self.run(server, handle, "save", &title, &options).await
    }

    async fn save_files(&self, #[zbus(object_server)] server: &zbus::ObjectServer, handle: OwnedObjectPath, app_id: String, parent_window: String, title: String, options: Options) -> (u32, Results) {
        self.run(server, handle, "saveFiles", &title, &options).await
    }
}

/// The open picker windows by label: what each was asked, and where its answer goes.
#[derive(Default)]
pub struct Picks(pub std::sync::Mutex<HashMap<String, (Request, Tx)>>);

/// The chooser that opens real windows: an Inode window titled "Inode: <the caller's title>" (so a window rule can
/// float it), started in the folder the caller named, which finds its request with the `pick_request` command.
pub fn chooser(app: &tauri::AppHandle) -> Chooser {
    let app = app.clone();
    Chooser(Box::new(move |req, tx| {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let label = format!("pick{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let mut cfg = app.config().app.windows[0].clone();
        cfg.label = label.clone();
        cfg.title = format!("Inode: {}", req.title);
        (cfg.width, cfg.height) = (960.0, 640.0);
        app.state::<crate::Starts>().0.lock().unwrap().insert(label.clone(), (req.folder.clone(), req.select.clone()));
        app.state::<Picks>().0.lock().unwrap().insert(label.clone(), (req, tx));
        // The window going away by itself (closed by the user, or never built) is a cancel.
        let gone = {
            let (app, label) = (app.clone(), label.clone());
            move || {
                if let Some((_, tx)) = app.state::<Picks>().0.lock().unwrap().remove(&label) {
                    let _ = tx.try_send(None);
                }
            }
        };
        let (a, l) = (app.clone(), label.clone());
        // On its own thread, like every Inode window (see open_window).
        std::thread::spawn(move || match tauri::WebviewWindowBuilder::from_config(&a, &cfg).and_then(|b| b.build()) {
            Ok(w) => {
                // Withdrawn while it was being built: nobody is waiting for it any more.
                if !a.state::<Picks>().0.lock().unwrap().contains_key(&l) {
                    let _ = w.close();
                }
                w.on_window_event(move |e| {
                    if matches!(e, tauri::WindowEvent::Destroyed) {
                        gone();
                    }
                });
            }
            Err(e) => {
                eprintln!("inode: could not open the file chooser window: {e}");
                gone();
            }
        });
        let app = app.clone();
        Box::new(move || {
            app.state::<Picks>().0.lock().unwrap().remove(&label);
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::Structure;

    fn options(pairs: Vec<(&str, Value<'static>)>) -> Options {
        pairs.into_iter().map(|(k, v)| (k.to_string(), OwnedValue::try_from(v).unwrap())).collect()
    }
    fn filter(name: &str, patterns: &[(u32, &str)]) -> RawFilter {
        (name.to_string(), patterns.iter().map(|(k, p)| (*k, p.to_string())).collect())
    }
    fn raw(f: &RawFilter) -> Value<'static> {
        Value::from(Structure::from(f.clone()))
    }
    const DB: &str = "# comment\n50:image/png:*.png\n50:image/jpeg:*.jpg\n50:image/jpeg:*.jpeg\n50:text/plain:*.txt\n60:application/x-foo:*.foo:cs\n";

    #[test]
    fn mime_types_become_globs() {
        assert_eq!(mime_globs(DB, "image/jpeg"), ["*.jpg", "*.jpeg"]);
        assert_eq!(mime_globs(DB, "image/*"), ["*.png", "*.jpg", "*.jpeg"]);
        assert_eq!(mime_globs(DB, "application/x-foo"), ["*.foo"]);
        assert!(mime_globs(DB, "application/x-unknown").is_empty());
    }

    #[test]
    fn open_options_are_read() {
        let (images, text, odd) = (filter("Images", &[(1, "image/*"), (0, "*.webp")]), filter("Text", &[(0, "*.txt")]), filter("Odd", &[(0, "*.x"), (1, "application/x-unknown")]));
        let o = options(vec![
            ("accept_label", "_Select".into()),
            ("multiple", true.into()),
            ("modal", true.into()),
            ("filters", Value::from(vec![images.clone(), text.clone()])),
            ("current_filter", raw(&odd)),
            ("current_folder", Value::from(b"/home/m/My Pictures\0".to_vec())),
            ("something_new", 7u32.into()),
        ]);
        let r = parse("open", "Pick photos", &o, &|m| mime_globs(DB, m));
        assert_eq!((r.mode, r.title.as_str(), r.accept.as_str(), r.multiple, r.directory), ("open", "Pick photos", "Select", true, false));
        assert_eq!(r.folder.as_deref(), Some("/home/m/My Pictures"));
        assert_eq!(r.filters[0], Filter { name: "Images".into(), globs: vec!["*.png".into(), "*.jpg".into(), "*.jpeg".into(), "*.webp".into()] });
        // The current filter was not in the list: it joins it. A mime type nobody knows makes its filter show everything.
        assert_eq!((r.filter, &r.filters[2]), (2, &Filter { name: "Odd".into(), globs: vec![] }));
        assert_eq!(r.raw, [images, text, odd]);

        let bare = parse("open", "Open", &Options::new(), &|_| vec![]);
        assert_eq!((bare.accept.as_str(), bare.multiple, bare.filter, bare.filters.len(), bare.folder), ("Open", false, 0, 0, None));
        let dir = parse("open", "Folder", &options(vec![("directory", true.into()), ("multiple", "wrong type".into())]), &|_| vec![]);
        assert_eq!((dir.accept.as_str(), dir.directory, dir.multiple), ("Choose folder", true, false));
    }

    #[test]
    fn save_options_are_read() {
        let o = options(vec![("current_name", "report.pdf".into()), ("current_folder", Value::from(b"/home/m/Documents\0".to_vec()))]);
        let r = parse("save", "Save as", &o, &|_| vec![]);
        assert_eq!((r.accept.as_str(), r.name.as_str(), r.folder.as_deref(), r.select), ("Save", "report.pdf", Some("/home/m/Documents"), None));
        // An existing file to save over: its folder, its name, and the cursor on it.
        let r = parse("save", "Save", &options(vec![("current_file", Value::from(b"/srv/x/old name.txt\0".to_vec()))]), &|_| vec![]);
        assert_eq!((r.name.as_str(), r.folder.as_deref(), r.select.as_deref()), ("old name.txt", Some("/srv/x"), Some("/srv/x/old name.txt")));
        let r = parse("saveFiles", "Save all", &options(vec![("files", Value::from(vec![b"a.txt\0".to_vec(), b"b c.txt\0".to_vec()]))]), &|_| vec![]);
        assert_eq!((r.accept.as_str(), r.directory, r.files), ("Save here", true, vec!["a.txt".to_string(), "b c.txt".to_string()]));
    }

    #[test]
    fn replies_carry_uris_and_the_filter_in_use() {
        let text = filter("Text", &[(0, "*.txt")]);
        let req = parse("open", "Open", &options(vec![("filters", Value::from(vec![filter("All", &[(0, "*")]), text.clone()]))]), &|_| vec![]);
        let r = reply(&req, &["/tmp/a b.txt".into(), "not/absolute".into(), "/tmp/ü#1".into()], 1);
        assert_eq!(r["uris"], Value::from(vec!["file:///tmp/a%20b.txt", "file:///tmp/%C3%BC%231"]));
        assert_eq!(r["current_filter"], raw(&text));
        assert_eq!(r["uris"].value_signature().to_string(), "as");
        assert_eq!(r["current_filter"].value_signature().to_string(), "(sa(us))");
        let none = parse("open", "Open", &Options::new(), &|_| vec![]);
        assert!(!reply(&none, &[], 0).contains_key("current_filter"));
    }

    /// The whole D-Bus side on a private bus (a dbus-daemon with no service directories, so nothing can be started
    /// by it): the three methods with their spec signatures, the reply, and the Request object's Close.
    #[test]
    fn serves_the_interface_on_a_private_bus() {
        use std::io::BufRead;
        let dir = std::env::temp_dir().join(format!("inode-portal-bus-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conf = dir.join("bus.conf");
        std::fs::write(&conf, format!("<busconfig><type>session</type><listen>unix:dir={}</listen><policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/><allow eavesdrop=\"true\"/><allow own=\"*\"/></policy></busconfig>", dir.display())).unwrap();
        let Ok(mut daemon) = std::process::Command::new("dbus-daemon").arg(format!("--config-file={}", conf.display())).args(["--nofork", "--print-address"]).stdout(std::process::Stdio::piped()).spawn() else {
            eprintln!("no dbus-daemon here: skipped");
            return;
        };
        let mut address = String::new();
        std::io::BufReader::new(daemon.stdout.take().unwrap()).read_line(&mut address).unwrap();
        let connect = || zbus::blocking::connection::Builder::address(address.trim()).unwrap().build().unwrap();

        // A stand-in for the window: answers at once, except the title "wait", which is left open.
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let server = connect();
        let open: Open = Box::new(move |req, tx| {
            if req.title != "wait" {
                let _ = tx.try_send(Some((vec![format!("/tmp/{}", if req.name.is_empty() { "picked file" } else { req.name.as_str() })], req.filter)));
            }
            log.lock().unwrap().push(req);
            Box::new(|| {})
        });
        server.object_server().at(PATH, Chooser(open)).unwrap();
        server.request_name(NAME).unwrap();

        let client = connect();
        let call = |method: &str, handle: &str, title: &str, o: Options| -> (u32, HashMap<String, OwnedValue>) {
            let handle = zbus::zvariant::ObjectPath::try_from(handle).unwrap();
            client.call_method(Some(NAME), PATH, Some("org.freedesktop.impl.portal.FileChooser"), method, &(handle, "org.example.App", "", title, o)).unwrap().body().deserialize().unwrap()
        };
        let text = filter("Text", &[(0, "*.txt")]);
        let (code, results) = call("OpenFile", "/org/freedesktop/portal/desktop/request/1_1/a", "Open a file", options(vec![("filters", Value::from(vec![text.clone()])), ("multiple", true.into())]));
        assert_eq!(code, 0);
        assert_eq!(Vec::<String>::try_from(results["uris"].try_clone().unwrap()).unwrap(), ["file:///tmp/picked%20file"]);
        assert_eq!(RawFilter::try_from(Value::from(results["current_filter"].try_clone().unwrap())).unwrap(), text);
        let (code, results) = call("SaveFile", "/org/freedesktop/portal/desktop/request/1_1/b", "Save", options(vec![("current_name", "new.txt".into())]));
        assert_eq!((code, Vec::<String>::try_from(results["uris"].try_clone().unwrap()).unwrap()), (0, vec!["file:///tmp/new.txt".to_string()]));
        let (code, _) = call("SaveFiles", "/org/freedesktop/portal/desktop/request/1_1/c", "Save all", options(vec![("files", Value::from(vec![b"a\0".to_vec()]))]));
        assert_eq!(code, 0);
        assert_eq!(seen.lock().unwrap().iter().map(|r| (r.mode, r.multiple)).collect::<Vec<_>>(), [("open", true), ("save", false), ("saveFiles", false)]);

        // A call left open is answered "cancelled" (1, no results) when the caller closes its Request object.
        let handle = "/org/freedesktop/portal/desktop/request/1_1/d";
        let waiting = std::thread::scope(|s| {
            let t = s.spawn(|| call("OpenFile", handle, "wait", Options::new()));
            let closer = connect();
            let closed = (0..100).any(|_| {
                std::thread::sleep(std::time::Duration::from_millis(50));
                closer.call_method(Some(NAME), handle, Some("org.freedesktop.impl.portal.Request"), "Close", &()).is_ok()
            });
            assert!(closed, "the Request object never appeared");
            t.join().unwrap()
        });
        assert_eq!((waiting.0, waiting.1.len()), (1, 0));

        let _ = daemon.kill();
        let _ = daemon.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
