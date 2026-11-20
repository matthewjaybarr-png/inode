// One table drives both the key handling and the "?" sheet, so the sheet can never drift from what the keys do.
// Each action: id, label, group, keys per preset (windows/vim fall back to default), extend = Shift also extends the selection.

export const PRESETS = { default: 'Default', windows: 'Windows Explorer', vim: 'Vim' };

export const ACTIONS = [
  // Settings come first in the "?" sheet, each with a button there (`toggle` = the saved setting an On/Off button flips).
  { id: 'askBin', group: 'Settings', label: 'Ask before sending to the bin', keys: [], toggle: 'askBin', run: (a) => a.toggleSetting('askBin', 'Delete asks before sending to the bin', 'Delete sends to the bin without asking') },
  { id: 'warnExt', group: 'Settings', label: 'Warn when a rename changes the extension', keys: [], toggle: 'warnExt', run: (a) => a.toggleSetting('warnExt', 'Rename warns when the extension changes', 'Rename changes extensions without asking') },
  { id: 'restoreTabs', group: 'Settings', label: 'Reopen tabs from last time', keys: [], toggle: 'restoreTabs', run: (a) => a.toggleSetting('restoreTabs', 'The next start reopens the tabs from last time', 'The next start opens the home folder, no old tabs') },
  { id: 'exportSettings', group: 'Settings', label: 'Export settings to this folder', keys: ['Ctrl+Alt+E'], run: (a) => a.exportSettings() },
  { id: 'importSettings', group: 'Settings', label: 'Import settings from the selected .json file', keys: ['Ctrl+Alt+I'], run: (a) => a.importSettings() },
  { id: 'alias', group: 'Settings', label: 'Alias this folder…', keys: ['Ctrl+Shift+A'], run: (a) => a.pane().askAlias() },

  { id: 'down', group: 'Move', label: 'Next item', keys: ['ArrowDown'], vim: ['ArrowDown', 'J'], extend: true, run: (a, e) => a.pane().step(0, 1, e.shiftKey) },
  { id: 'up', group: 'Move', label: 'Previous item', keys: ['ArrowUp'], vim: ['ArrowUp', 'K'], extend: true, run: (a, e) => a.pane().step(0, -1, e.shiftKey) },
  { id: 'pageDown', group: 'Move', label: 'Page down', keys: ['PageDown'], vim: ['PageDown', 'Ctrl+F'], extend: true, run: (a, e) => a.pane().move(a.pane().cursor + a.pane().pageSize(), e.shiftKey) },
  { id: 'pageUp', group: 'Move', label: 'Page up', keys: ['PageUp'], vim: ['PageUp', 'Ctrl+B'], extend: true, run: (a, e) => a.pane().move(a.pane().cursor - a.pane().pageSize(), e.shiftKey) },
  { id: 'first', group: 'Move', label: 'First item', keys: ['Home'], vim: ['Home', 'G'], extend: true, run: (a, e) => a.pane().move(0, e.shiftKey) },
  { id: 'last', group: 'Move', label: 'Last item', keys: ['End'], vim: ['End', 'Shift+G'], extend: true, run: (a, e) => a.pane().move(a.pane().rows.length - 1, e.shiftKey) },
  { id: 'open', group: 'Move', label: 'Open', keys: ['Enter'], vim: ['Enter', 'L'], run: (a) => a.pane().activate() },
  { id: 'parent', group: 'Move', label: 'Parent folder', keys: ['Backspace', 'Alt+ArrowUp'], windows: ['Alt+ArrowUp'], vim: ['Backspace', 'H', 'Alt+ArrowUp'], run: (a) => a.pane().up() },
  { id: 'back', group: 'Move', label: 'Back', keys: ['Alt+ArrowLeft'], windows: ['Alt+ArrowLeft', 'Backspace'], vim: ['Alt+ArrowLeft', 'Shift+H'], run: (a) => a.pane().goBack() },
  { id: 'forward', group: 'Move', label: 'Forward', keys: ['Alt+ArrowRight'], vim: ['Alt+ArrowRight', 'Shift+L'], run: (a) => a.pane().goForward() },
  { id: 'editPath', group: 'Move', label: 'Type a path', keys: ['Ctrl+L'], windows: ['Ctrl+L', 'Alt+D', 'F4'], run: (a) => a.pane().editPath() },
  { id: 'crumbMenu', group: 'Move', label: 'Folders beside this one (breadcrumb list; ← → move along the path)', keys: ['Alt+ArrowDown'], run: (a) => a.pane().crumbMenu() },
  { id: 'search', group: 'Move', label: 'Search this folder and subfolders', keys: ['Ctrl+F'], windows: ['Ctrl+F', 'Ctrl+E'], vim: ['Ctrl+Shift+F'], run: (a) => a.pane().openSearch() },
  { id: 'toggleSelect', group: 'Select', label: 'Select / unselect item', keys: ['Insert', 'Ctrl+Space'], run: (a) => a.pane().toggleSelect() },
  { id: 'selectAll', group: 'Select', label: 'Select all', keys: ['Ctrl+A'], run: (a) => a.pane().selectAll() },

  { id: 'switchPane', group: 'Panes', label: 'Switch pane', keys: ['Tab', 'F6'], run: (a) => a.state.dual && a.focus(1 - a.active) },
  { id: 'leftPane', group: 'Panes', label: 'Left pane', keys: ['Ctrl+ArrowLeft'], run: (a) => a.state.dual && a.focus(0) },
  { id: 'rightPane', group: 'Panes', label: 'Right pane', keys: ['Ctrl+ArrowRight'], run: (a) => a.state.dual && a.focus(1) },
  { id: 'toggleDual', group: 'Panes', label: 'Two panes on / off', keys: ['F3'], run: (a) => a.toggleDual() },
  { id: 'swap', group: 'Panes', label: 'Swap folders', keys: ['Ctrl+U'], run: (a) => a.swap() },
  { id: 'sameFolder', group: 'Panes', label: 'Same folder in other pane', keys: ['Ctrl+O'], run: (a) => a.state.dual && a.other().go(a.pane().path) },
  { id: 'preview', group: 'Panes', label: 'Preview on / off', keys: ['Alt+P'], vim: ['Alt+P', 'P'], run: (a) => a.togglePreview() },

  { id: 'newWindow', group: 'Tabs', label: 'New window', keys: ['Ctrl+N'], run: (a) => a.newWindow() },
  { id: 'newTab', group: 'Tabs', label: 'New tab', keys: ['Ctrl+T'], run: (a) => a.pane().newTab() },
  { id: 'openNewTab', group: 'Tabs', label: 'Open folder in new tab', keys: ['Ctrl+Enter'], run: (a) => { const e = a.pane().rows[a.pane().cursor]; if (e?.dir) a.pane().newTab(e.path); } },
  { id: 'closeTab', group: 'Tabs', label: 'Close tab', keys: ['Ctrl+W'], run: (a) => a.pane().closeTab() },
  { id: 'nextTab', group: 'Tabs', label: 'Next tab', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], run: (a) => a.pane().cycleTab(1) },
  { id: 'prevTab', group: 'Tabs', label: 'Previous tab', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], run: (a) => a.pane().cycleTab(-1) },
  { id: 'reopenTab', group: 'Tabs', label: 'Reopen closed tab', keys: ['Ctrl+Shift+T'], run: (a) => a.pane().reopenTab() },

  { id: 'rename', group: 'Files', label: 'Rename', keys: ['F2'], vim: ['F2', 'R'], run: (a) => a.ops.rename() },
  { id: 'newFolder', group: 'Files', label: 'New folder', keys: ['Ctrl+Shift+N'], run: (a) => a.ops.newItem(true) },
  { id: 'newFile', group: 'Files', label: 'New file', keys: ['Ctrl+Alt+N'], run: (a) => a.ops.newItem(false) },
  { id: 'copyOther', group: 'Files', label: 'Copy to other pane', keys: ['Ctrl+Shift+C'], vim: ['Ctrl+Shift+C', 'Y'], run: (a) => a.ops.transfer(false) },
  { id: 'moveOther', group: 'Files', label: 'Move to other pane', keys: ['Ctrl+Shift+X'], vim: ['Ctrl+Shift+X', 'M'], run: (a) => a.ops.transfer(true) },
  { id: 'cut', group: 'Files', label: 'Cut', keys: ['Ctrl+X'], vim: ['Ctrl+X', 'X'], run: (a) => a.ops.clip(true) },
  { id: 'copy', group: 'Files', label: 'Copy', keys: ['Ctrl+C'], vim: ['Ctrl+C', 'Shift+Y'], run: (a) => a.ops.clip(false) },
  { id: 'paste', group: 'Files', label: 'Paste here', keys: ['Ctrl+V'], vim: ['Ctrl+V', 'Shift+P'], run: (a) => a.ops.paste() },
  { id: 'copyPath', group: 'Files', label: 'Copy path', keys: ['Ctrl+Alt+Shift+C'], run: (a) => a.copyPath() },
  { id: 'terminal', group: 'Files', label: 'Open in terminal', keys: ['Ctrl+Alt+T'], run: (a) => a.openTerminal() },
  { id: 'shortcut', group: 'Files', label: 'Create shortcut (Linux: a link)', keys: ['Ctrl+Shift+L'], run: (a) => a.ops.shortcut() },
  { id: 'compress', group: 'Files', label: 'Compress to .zip', keys: [], run: (a) => a.ops.compress() },
  { id: 'extractHere', group: 'Files', label: 'Extract archive here', keys: ['Alt+E'], run: (a) => a.ops.extract(false) },
  { id: 'extractTo', group: 'Files', label: 'Extract archive to its own folder', keys: ['Alt+Shift+E'], run: (a) => a.ops.extract(true) },
  { id: 'properties', group: 'Files', label: 'Properties', keys: ['Alt+Enter'], run: (a) => a.showProps() },
  { id: 'trash', group: 'Files', label: 'Delete (to Trash / Recycle Bin)', keys: ['Delete'], vim: ['Delete', 'D'], run: (a) => a.ops.trash() },
  { id: 'deleteForever', group: 'Files', label: 'Delete permanently', keys: ['Shift+Delete'], run: (a) => a.ops.deleteForever() },
  { id: 'undo', group: 'Files', label: 'Undo', keys: ['Ctrl+Z'], vim: ['Ctrl+Z', 'U'], run: (a) => a.ops.undo() },
  { id: 'redo', group: 'Files', label: 'Redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], run: (a) => a.ops.redo() },

  { id: 'goTrash', group: 'Trash and Recent', label: 'Open the Trash / Recycle Bin', keys: ['Alt+Delete'], run: (a) => a.goKind('trash') },
  { id: 'restore', group: 'Trash and Recent', label: 'Restore from the Trash', keys: ['Alt+R'], run: (a) => a.ops.restore(false) },
  { id: 'restoreAll', group: 'Trash and Recent', label: 'Restore everything in the Trash', keys: ['Alt+Shift+R'], run: (a) => a.ops.restore(true) },
  { id: 'emptyTrash', group: 'Trash and Recent', label: 'Empty the Trash', keys: ['Ctrl+Shift+Delete'], run: (a) => a.ops.purge(true) },
  { id: 'goRecent', group: 'Trash and Recent', label: 'Open Recent', keys: ['Alt+H'], run: (a) => a.goKind('recent') },
  { id: 'openFolder', group: 'Trash and Recent', label: 'Open containing folder', keys: ['Ctrl+Alt+O'], run: (a) => a.openFolder() },

  { id: 'refresh', group: 'View', label: 'Refresh', keys: ['F5', 'Ctrl+R'], run: (a) => a.pane().refresh() },
  { id: 'hidden', group: 'View', label: 'Show / hide hidden items', keys: ['Ctrl+H', 'Ctrl+.'], run: (a) => a.toggleHidden() },
  { id: 'sortName', group: 'View', label: 'Sort by name', keys: ['Ctrl+Shift+1'], run: (a) => a.setSort('name') },
  { id: 'sortSize', group: 'View', label: 'Sort by size', keys: ['Ctrl+Shift+2'], run: (a) => a.setSort('size') },
  { id: 'sortDate', group: 'View', label: 'Sort by date', keys: ['Ctrl+Shift+3'], run: (a) => a.setSort('date') },
  { id: 'sortKind', group: 'View', label: 'Sort by type', keys: ['Ctrl+Shift+4'], run: (a) => a.setSort('kind') },
  { id: 'pin', group: 'View', label: 'Pin / unpin this folder', keys: ['Ctrl+D'], run: (a) => a.togglePin(a.pane().path) },
  { id: 'pinItem', group: 'View', label: 'Pin / unpin the file or folder under the cursor', keys: ['Ctrl+Shift+D'], run: (a) => a.togglePin(a.pane().rows[a.pane().cursor]?.path) },
  { id: 'menu', group: 'View', label: 'Menu for the item under the cursor', keys: ['Shift+F10', 'ContextMenu'], run: (a) => a.cursorMenu() },
  { id: 'help', group: 'View', label: 'Settings and keyboard shortcuts', keys: ['?', 'F1'], run: (a) => a.showKeys() },
  // Grid, tile size, columns and sort options: also in each pane's ☰ menu and on a right-click of the column header.
  { id: 'gridView', group: 'View', label: 'Grid / list view', keys: ['Ctrl+G'], run: (a) => a.pane().setView({ grid: !a.pane().grid }) },
  { id: 'tileBigger', group: 'View', label: 'Grid: larger tiles (also Ctrl+wheel)', keys: ['Ctrl+=', 'Ctrl++'], run: (a) => a.pane().setTile(1) },
  { id: 'tileSmaller', group: 'View', label: 'Grid: smaller tiles (also Ctrl+wheel)', keys: ['Ctrl+-'], run: (a) => a.pane().setTile(-1) },
  { id: 'left', group: 'View', label: 'Grid: item to the left', keys: ['ArrowLeft'], extend: true, run: (a, e) => a.pane().step(-1, 0, e.shiftKey) },
  { id: 'right', group: 'View', label: 'Grid: item to the right', keys: ['ArrowRight'], extend: true, run: (a, e) => a.pane().step(1, 0, e.shiftKey) },
  { id: 'viewMenu', group: 'View', label: 'View menu (tile size, sort, columns)', keys: ['Alt+V'], run: (a) => a.pane().viewMenu() },
  { id: 'sortCreated', group: 'View', label: 'Sort by date created', keys: ['Ctrl+Shift+5'], run: (a) => a.setSort('created') },
  { id: 'sortMode', group: 'View', label: 'Sort by permissions (Linux)', keys: ['Ctrl+Shift+6'], run: (a) => a.setSort('mode') },
  { id: 'dirsFirst', group: 'View', label: 'Folders first', keys: [], toggle: 'dirsFirst', run: (a) => a.toggleView('dirsFirst', 'Folders first') },
  { id: 'natural', group: 'View', label: 'Number order (file2 before file10)', keys: [], toggle: 'natural', run: (a) => a.toggleView('natural', 'Number order (file2 before file10)') },
  { id: 'hiddenLast', group: 'View', label: 'Hidden items last', keys: [], toggle: 'hiddenLast', run: (a) => a.toggleView('hiddenLast', 'Hidden items last') },
  { id: 'colSize', group: 'View', label: 'Column: Size (folders show their item count)', keys: [], toggle: 'colSize', run: (a) => a.toggleView('colSize', 'Column: Size (folders show their item count)') },
  { id: 'colDate', group: 'View', label: 'Column: Modified', keys: [], toggle: 'colDate', run: (a) => a.toggleView('colDate', 'Column: Modified') },
  { id: 'colKind', group: 'View', label: 'Column: Type', keys: [], toggle: 'colKind', run: (a) => a.toggleView('colKind', 'Column: Type') },
  { id: 'colCreated', group: 'View', label: 'Column: Created', keys: [], toggle: 'colCreated', run: (a) => a.toggleView('colCreated', 'Column: Created') },
  { id: 'colMode', group: 'View', label: 'Column: Permissions (Linux)', keys: [], toggle: 'colMode', run: (a) => a.toggleView('colMode', 'Column: Permissions (Linux)') },
  { id: 'perFolder', group: 'View', label: 'Remember view per folder (list or grid, tile size, sort)', keys: [], toggle: 'perFolder', run: (a) => a.toggleView('perFolder', 'Remember view per folder (list or grid, tile size, sort)') },
  { id: 'viewDefault', group: 'View', label: 'Use this view for folders with none remembered', keys: [], run: (a) => a.pane().makeDefault() },

  { id: 'filter', group: 'Find and go', label: 'Filter this list by name as you type', keys: ['/'], run: (a) => a.pane().openFilter() },
  { id: 'jump', group: 'Find and go', label: 'Jump to a pin, alias, place or recent folder', keys: [':'], run: (a) => a.jump() },
  { id: 'palette', group: 'Find and go', label: 'Command palette: find and run any command', keys: ['Ctrl+Shift+P'], run: (a) => a.palette() },
  { id: 'quickLook', group: 'Find and go', label: 'Quick look: large preview of the item under the cursor', keys: ['Space'], run: (a, e) => e?.repeat || a.quickLook() },
];

// "Ctrl+Shift+N", "Alt+ArrowUp", "?" … Shift is dropped for symbols (it is already in the character), kept for letters and digits.
export function comboOf(e) {
  let k = e.key;
  if (/^Digit\d$/.test(e.code) && (e.ctrlKey || e.metaKey || e.altKey)) k = e.code.slice(5);
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  const symbol = k.length === 1 && !/[A-Z0-9]/.test(k);
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && !symbol && 'Shift', k].filter(Boolean).join('+');
}

export const keysFor = (action, preset, overrides = {}) => overrides[action.id] ?? action[preset] ?? action.keys;

// combo -> action for the preset, user overrides winning over preset keys.
export function buildMap(preset, overrides = {}) {
  const map = new Map();
  for (const a of ACTIONS) for (const c of a[preset] ?? a.keys) map.set(c, a);
  for (const a of ACTIONS) for (const c of overrides[a.id] ?? []) map.set(c, a);
  // A key reassigned away from an action stops running it.
  for (const [c, a] of map) if (!keysFor(a, preset, overrides).includes(c)) map.delete(c);
  return map;
}

export function lookup(map, e) {
  const c = comboOf(e);
  const hit = map.get(c);
  if (hit) return hit;
  if (e.shiftKey && c.includes('Shift+')) { const a = map.get(c.replace('Shift+', '')); if (a?.extend) return a; }
  return null;
}

// Pretty key names for the sheet.
export const label = (c) => c.replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('ArrowLeft', '←').replace('ArrowRight', '→');
