// Colour tags and custom actions: what app.js, pane.js and extras.js call for both.
// Tags live in one file the backend owns (tags.rs); app.tags is this window's copy of it (path -> colour).
// Custom actions are the user's .toml files (actions.rs); app.actions is the list that can run here.
import { TAG_COLOURS, TAGS, TRASH, isFolder, actionsFor } from './util.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const dot = (c) => { const d = el('span', 'tag-dot'); d.style.background = `var(--tag-${c})`; return d; };
const cap = (c) => c[0].toUpperCase() + c.slice(1);

export function setupAddons(app) {
  app.tags = {}; app.actions = [];

  // ---- Colour tags
  // Draws the tags again wherever they show: the sidebar section, the dots, and a "Tagged …" list (read again).
  const retag = (tags) => {
    if (JSON.stringify(tags) === JSON.stringify(app.tags)) return;
    app.tags = tags;
    app.renderPlaces();
    for (const p of app.panes) if (p.path != null) { if (p.path.startsWith(TAGS)) p.refresh(); else p.render(p.rows[p.cursor]?.path); }
  };
  // Every folder listing asks (pane.js go): the backend drops the tags of items gone from `dir`, and what another
  // window tagged meanwhile arrives here.
  app.loadTags = (dir) => invoke('tags', { dir: isFolder(dir) ? dir : null }).then(retag, () => {});
  // Tags the selection (or the cursor item) `colour`; null removes the tag.
  app.setTag = async (colour) => {
    const p = app.pane(), paths = p.targets();
    if (p.path === TRASH) return app.flash('Restore an item first to tag it');
    if (!paths.length) return app.flash('Nothing to tag: select a file or folder first');
    try { retag(await invoke('set_tags', { paths, colour })); } catch (e) { return app.flash(`Could not save the tag: ${e}`); }
    const what = paths.length === 1 ? paths[0].split(/[\\/]/).pop() : `${paths.length} items`;
    app.flash(colour ? `Tagged ${what} ${colour}` : `Removed the tag from ${what}`);
  };
  // The right-click menu's row: seven colour dots and "No tag", for the selection.
  app.tagRow = () => {
    const row = el('div', 'tag-row'), paths = app.pane().targets(), now = new Set(paths.map((p) => app.tags[p]));
    const pick = (c) => () => { app.closeSideMenu(); app.pane().list.focus(); app.setTag(c); };
    for (const c of TAG_COLOURS) {
      const b = el('button', now.has(c) ? 'on' : '');
      b.title = `Tag ${c}`; b.setAttribute('aria-label', b.title); b.setAttribute('role', 'menuitem'); b.onclick = pick(c); b.append(dot(c));
      row.append(b);
    }
    const none = el('button', 'none', 'No tag');
    none.title = 'Remove the tag'; none.setAttribute('role', 'menuitem'); none.disabled = !paths.some((p) => app.tags[p]); none.onclick = pick(null);
    row.append(none);
    return row;
  };
  // The sidebar's Tags section: one row per colour in use; a click lists everything tagged that colour.
  app.tagPlaces = (nav, flip) => {
    const used = TAG_COLOURS.filter((c) => Object.values(app.tags).includes(c)), folded = app.state.side.fold.includes('Tags');
    if (!used.length) return;
    const h = el('button', 'group', 'Tags');
    h.dataset.key = 'g:Tags'; h.setAttribute('aria-expanded', String(!folded)); h.title = folded ? 'Show Tags' : 'Fold Tags'; h.onclick = () => flip(app.state.side.fold, 'Tags');
    nav.append(h);
    if (folded) return;
    for (const c of used) {
      const row = el('div', 'side-row'), b = el('button', 'place', cap(c));
      b.prepend(dot(c)); b.dataset.key = `t:${c}`; b.title = `Everything tagged ${c}`; b.onclick = () => app.goPlace(TAGS + c);
      row.append(b); nav.append(row);
    }
  };

  // ---- Custom actions
  // `say` = asked for by hand (Reload actions): tell how many there are.
  app.loadActions = async (say) => {
    try { app.actions = await invoke('actions'); } catch (e) { return app.flash(`Could not read the actions: ${e}`); }
    if (say) app.flash(app.actions.length ? `${app.actions.length} custom action${app.actions.length === 1 ? '' : 's'}: ${app.actions.map((a) => a.name).join(', ')}` : 'No custom actions yet: Settings, Open actions folder, has an example to start from');
  };
  app.openActionsFolder = () => invoke('actions_dir').then((dir) => { app.goPlace(dir); app.flash(`Actions folder: one .toml file per action · example.toml shows how · Reload actions when done`); }, (e) => app.flash(`Could not open the actions folder: ${e}`));
  // Runs it on the paths, in the pane's folder; the status bar says how it ended (a non-zero exit code is named).
  const run = (a, label, paths) => {
    const p = app.pane(), dir = isFolder(p.path) ? p.path : paths[0].replace(/[\\/][^\\/]*$/, '') || '/';
    app.flash(`${label}…`);
    invoke('run_action', { id: a.id, paths, dir, option: app.state.actionOpts?.[a.id] ?? null })
      .then((said) => { app.flash(said); app.panes.forEach((q) => q.refresh()); }, (e) => app.flash(String(e)));
  };
  // Menu items ([text, run], after a separator) for the actions that fit the selection; none = nothing added.
  app.actionItems = () => {
    const p = app.pane(), paths = p.targets(), sel = p.path === TRASH ? [] : p.rows.filter((r) => paths.includes(r.path));
    const fit = actionsFor(app.actions, sel);
    return fit.length ? [null, ...fit.map(({ a, label }) => [label, () => { app.closeSideMenu(); p.list.focus(); run(a, label, paths); }])] : [];
  };
  // Settings sheet: the actions found, each with its one setting (an omanta `option`) when it has one.
  app.actionRows = (body) => {
    body.append(el('h3', '', 'Custom actions · in the right-click menu and the command palette'));
    if (!app.actions.length) body.append(el('div', 'side-note', 'None yet. "Open actions folder" above makes the folder with an example file; "Reload actions" reads them again.'));
    for (const a of app.actions) {
      const row = el('div', 'key-row');
      row.append(el('span', 'key-label', `${a.name}${a.terminal ? ' (in a terminal)' : ''}`), el('kbd', '', `${a.id}.toml`));
      if (a.option) {
        const s = el('select', 'opt'), l = el('label', '', `${a.option_label || a.option} `);
        for (const c of a.option_choices) { const [v, ...t] = c.split('='); s.append(new Option(t.join('=').trim() || v.trim(), v.trim())); }
        s.value = app.state.actionOpts[a.id] ?? s.options[0].value; if (s.selectedIndex < 0) s.selectedIndex = 0;
        s.onchange = () => { app.state.actionOpts[a.id] = s.value; app.saveState(); };
        l.append(s); row.append(l);
      }
      body.append(row);
    }
  };

  app.loadTags(null); app.loadActions();
  // Back in this window: the user may have edited an action file, or tagged something in another window.
  addEventListener('focus', () => { app.loadActions(); app.loadTags(null); });
}
