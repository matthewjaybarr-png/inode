# Inode

A keyboard-first, two-pane file manager for [Omarchy](https://omarchy.org). Built with Tauri 2: a Rust
backend and a plain HTML/JS interface with no bundler.

Status: early. It works day to day, but expect rough edges.

## What it does

- Two panes side by side (F3 for one), tabs in each pane, copy or move to the other pane.
- Rebindable keys with default, Windows and vim presets; `?` shows every key.
- Pinned files and folders, a quiet sidebar you can hide entries from, eject for removable drives.
- Preview pane for text, images and PDFs; search in a folder and below it.
- Copy, cut and paste with other apps; drag and drop; new file and folder; rename.
- Trash with restore, a Trash place and a Recent place; undo and redo.
- Folder aliases (`@name` in the path bar), breadcrumb drop-downs, a details pane, settings export and import.
- Compress to zip; extract zip, 7z, tar and rar (through `bsdtar`).
- Follows the Omarchy theme live.
- Can be the default file manager: "Show in folder" from browsers opens Inode.

## Build

Needs Rust, Node and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run build -- --bundles appimage
```

Tests: `npm test` and `cargo test --lib` in `src-tauri`.

## Make it the default file manager

```bash
inode --default on
```

This sets the folder handler, the `org.freedesktop.FileManager1` service and the file-manager keys in
`~/.config/hypr/bindings.lua`, all per user. `inode --default off` puts everything back as it was, and
`inode --default status` shows what is active.

Optional tools: `wl-clipboard` (copy and paste with other apps), `bsdtar` (extract), `udisks2` (eject).

## Credits

The feature set was shaped by using [flea](https://github.com/thisisgm/flea),
[omanta](https://github.com/28allday/omanta) and [Files](https://files.community). No code was taken
from them.

## License

MIT
