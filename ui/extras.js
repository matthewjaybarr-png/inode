// Bulk rename panel, the ":" jump box, the command palette and quick look. Each is an overlay: app.over holds the open
// one, the key dispatcher in app.js sends it every key (Escape closes), and closing hands focus back to the list.
import { bulkNames, renameSteps, fuzzyRank, expandAlias, resolveTyped, isFolder, placeName, WIN } from './util.js';
import { ACTIONS, keysFor, label } from './keys.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (text, title, run, cls) => { const b = el('button', cls, text); b.title = title; b.onclick = run; return b; };

export function setupExtras(app) {
  // Opens an overlay and returns its card to fill. `key(e)` gets the keys Escape does not take.
  const open = (cls, name, key) => {
    app.closeOver(); app.closeSideMenu();
    const box = el('div', `over ${cls}`), card = el('div', 'keys-card');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', name);
    box.onmousedown = (e) => { if (e.target === box) app.closeOver(); }; // a press outside the card closes it
    box.append(card); document.body.append(box);
    app.over = { box, key, back: app.pane().list };
    return card;
  };
  app.closeOver = () => { const o = app.over; if (!o) return; app.over = null; o.box.remove(); o.back.focus(); };

  // One list to pick from by typing. `items(typed)` gives [{ text, hint, run(ev) }], best first; Up/Down move,
  // Enter or a click closes the box and runs the highlighted one (`ev` tells run whether Ctrl was held).
  const pick = (name, items, foot) => {
    const card = open('pick', name), input = el('input', 'pick-input'), list = el('div', 'pick-list');
    input.placeholder = name; input.spellcheck = false; input.setAttribute('aria-label', name);
    list.setAttribute('role', 'listbox');
    let rows = [], at = 0;
    const paint = () => {
      [...list.children].forEach((r, i) => { r.classList.toggle('cursor', i === at); r.setAttribute('aria-selected', String(i === at)); });
      list.children[at]?.scrollIntoView({ block: 'nearest' });
    };
    const run = (ev) => { const it = rows[at]; if (it) { app.closeOver(); it.run(ev); } };
    const draw = () => {
      rows = items(input.value).slice(0, 200); at = 0; // shortcut: shows the best 200, type more to narrow; window the list if that is ever too few
      list.replaceChildren(...rows.map((it, i) => {
        const r = el('div', 'pick-row'); r.setAttribute('role', 'option');
        r.append(el('span', 'pick-text', it.text), el('span', 'pick-hint', it.hint || ''));
        r.onclick = (ev) => { at = i; run(ev); };
        return r;
      }));
      if (!rows.length) list.append(el('div', 'pv-note', 'Nothing matches'));
      paint();
    };
    input.oninput = draw;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(e); } // stopped: the command it runs must not see this Enter too
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { at = (at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length; paint(); } }
    };
    card.append(input, list, el('div', 'pick-foot', foot));
    draw(); input.focus();
  };

  // ":" jump: pins, aliases, sidebar places and drives, then recently visited folders. Enter goes there in the active
  // pane, Ctrl+Enter in the other one. A typed path or "@alias/sub" is offered first, as it is.
  app.jump = () => {
    const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const go = async (path, ev) => {
      const p = ev?.ctrlKey || ev?.metaKey ? (app.state.dual ? app.other() : null) : app.pane();
      if (!p) return app.flash('Turn on the second pane (F3) to jump there');
      // A pinned file: its folder, with the file under the cursor.
      if (isFolder(path) && await invoke('probe', { path }).catch(() => '') === 'file') return p.go(path.replace(/[\\/][^\\/]*$/, '') || '/', { keep: path });
      return p.go(path);
    };
    const seen = new Set(), all = [];
    const add = (text, path, kind) => {
      const k = `${text}\n${path}`;
      if (path != null && !seen.has(k)) { seen.add(k); all.push({ text, path, hint: `${kind} · ${placeName(path) ?? path}`, run: (ev) => go(path, ev) }); }
    };
    for (const p of app.state.pins) add(base(p), p, 'pin');
    for (const [k, p] of Object.entries({ h: app.home, ...app.state.aliases })) add(`@${k}`, p, 'alias');
    for (const pl of app.places) add(pl.name, pl.path, pl.kind === 'drive' ? 'drive' : 'place');
    for (const p of app.state.recents || []) add(base(p), p, 'recent');
    const typed = (q) => {
      const v = q.trim();
      const t = v.startsWith('@') ? (/[\\/]/.test(v) ? expandAlias(v, app.state.aliases, app.home) : null) : /^(~|[\\/]|[A-Za-z]:|file:)/.test(v) ? resolveTyped(v, app.home) : null;
      return t ? [{ text: `Go to ${t}`, hint: 'typed path', run: (ev) => go(t, ev) }] : [];
    };
    pick('Jump to: a name, @alias, or a path', (q) => [...typed(q), ...fuzzyRank(q, all, (x) => `${x.text} ${x.path}`)],
      `Enter opens it in this pane · Ctrl+Enter in the other pane · Esc closes`);
  };

  // Command palette: every action of the keymap table with its current key; Enter runs it on the active pane.
  app.palette = () => {
    const all = ACTIONS.filter((a) => a.id !== 'palette').map((a) => ({
      text: `${a.group}: ${a.label}`, hint: keysFor(a, app.state.preset, app.state.keys).map(label).join('  '), run: () => a.run(app, {}),
    }));
    pick('Run a command: type part of its name', (q) => fuzzyRank(q, all, (x) => x.text), 'Enter runs it on the active pane · Esc closes');
  };

  // Quick look: the cursor item in most of the window, drawn by the same code as the preview column.
  // Space or Esc closes; the arrow keys (or the buttons) step to the previous / next item without closing.
  app.quickLook = () => {
    const p = app.pane();
    if (!p.rows[p.cursor]) return app.flash('Nothing under the cursor to look at');
    const step = (d) => { const to = p.cursor + d; if (to >= 0 && to < p.rows.length) { p.move(to, false); draw(); } };
    const card = open('look', 'Quick look', (e) => {
      const d = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
      if (e.key === ' ') { e.preventDefault(); if (!e.repeat) app.closeOver(); } else if (d) { e.preventDefault(); step(d); }
    });
    const box = app.over.box, head = el('header'), name = el('strong'), info = el('div', 'look-info'), body = el('div', 'look-body');
    head.append(name, btn('‹ Previous', 'Previous item (↑ or ←)', () => step(-1)), btn('Next ›', 'Next item (↓ or →)', () => step(1)), btn('Close', 'Close (Space or Esc)', () => app.closeOver()));
    card.append(head, body, info);
    card.tabIndex = -1; // the card holds focus, not a button: the Space that opened this must not press one on its way up
    let seq = 0;
    const draw = async () => {
      const e = p.rows[p.cursor], t = ++seq;
      name.textContent = `${e.name} · ${p.cursor + 1} of ${p.rows.length}`; name.title = e.path;
      info.replaceChildren(); body.replaceChildren();
      app.showDetails(e, info);
      const node = await app.previewNode(e);
      if (t === seq && app.over?.box === box) body.replaceChildren(node);
    };
    draw(); card.focus();
  };

  // Bulk rename (Rename with two or more selected): the options, a live old → new preview, and Rename only once no
  // row collides or is invalid. The names come from bulkNames, the order from renameSteps (util.js), the renaming and
  // its one Undo from ops.renameMany.
  app.bulkRename = () => {
    const p = app.pane(), items = p.rows.filter((r) => p.selected.has(r.path));
    if (items.length < 2) return;
    if (!items.every((it) => p.entries.includes(it))) return app.flash('Bulk rename works on the items of this folder, not on search results from subfolders');
    const dir = items[0].path.slice(0, -items[0].name.length), others = p.entries.map((e) => e.name);
    const card = open('bulk', `Rename ${items.length} items`);
    const text = (hint) => { const i = el('input'); i.type = 'text'; i.spellcheck = false; i.placeholder = hint; return i; };
    const num = (v, min) => { const i = el('input'); i.type = 'number'; i.value = v; i.min = min; i.step = 1; return i; };
    const tick = () => { const i = el('input'); i.type = 'checkbox'; return i; };
    const select = (opts) => { const s = el('select'); for (const [v, t] of opts) s.append(new Option(t, v)); return s; };
    const field = (name, node, cls = 'bulk-field') => { const l = el('label', cls); if (node.type === 'checkbox') l.append(node, name); else l.append(el('span', '', name), node); return l; };
    const find = text('text to look for'), repl = text('what to put there'), rx = tick(), mc = tick(), ext = tick(), pre = text('added in front'), suf = text('added at the end');
    const pos = select([['', 'No numbers'], ['before', 'Before the name'], ['after', 'After the name']]), start = num(1), step = num(1), pad = num(1, 1);
    const kase = select([['keep', 'Keep as it is'], ['lower', 'lower case'], ['upper', 'UPPER CASE'], ['title', 'Title Case']]);
    const head = el('header'), form = el('div', 'bulk-form'), list = el('div', 'bulk-list'), foot = el('div', 'bulk-foot'), msg = el('span', 'msg');
    const ok = btn('Rename', 'Rename them as the preview shows (Enter)', () => apply(), 'primary');
    head.append(el('strong', '', `Rename ${items.length} items`), btn('Close', 'Close without renaming (Esc)', () => app.closeOver()));
    const line = (...kids) => { const d = el('div', 'bulk-line'); d.append(...kids); return d; };
    form.append(line(field('Find', find), field('Replace with', repl)),
      line(field('Regular expression', rx, 'bulk-tick'), field('Match case', mc, 'bulk-tick'), field('Include extension', ext, 'bulk-tick')),
      line(field('Prefix', pre), field('Suffix', suf)),
      line(field('Numbering', pos), field('Start', start, 'bulk-num'), field('Step', step, 'bulk-num'), field('Digits', pad, 'bulk-num')),
      line(field('Letter case', kase)));
    foot.append(msg, ok, btn('Cancel', 'Close without renaming (Esc)', () => app.closeOver()));
    card.append(head, form, list, foot);
    let plan = null, busy = false;
    const update = () => {
      const r = bulkNames(items, { find: find.value, replace: repl.value, regex: rx.checked, matchCase: mc.checked, ext: ext.checked, prefix: pre.value, suffix: suf.value, numPos: pos.value, start: start.value, step: step.value, pad: pad.value, kase: kase.value }, others, WIN);
      const changed = r.rows.filter((x) => x.to !== x.from).length, bad = r.rows.filter((x) => x.error).length;
      list.replaceChildren(...r.rows.map((x) => {
        const row = el('div', `bulk-row${x.error ? ' bad' : x.to === x.from ? ' same' : ''}`);
        row.append(el('span', 'bulk-old', x.from), el('span', 'bulk-arrow', '→'), el('span', 'bulk-new', x.to || '(empty)'));
        if (x.error) row.append(el('span', 'bulk-why', `✕ ${x.error}`));
        return row;
      }));
      msg.textContent = r.error || (bad ? `${bad} name${bad === 1 ? '' : 's'} cannot be used (marked ✕): change the options` : changed ? `${changed} of ${items.length} will be renamed · Ctrl+Z afterwards puts them back` : 'Nothing changes yet: fill in an option above');
      plan = !r.error && !bad && changed ? r.rows : null;
      ok.disabled = !plan;
      for (const i of [start, step, pad]) i.disabled = !pos.value;
    };
    const apply = async () => {
      if (!plan || busy) return;
      busy = true;
      const rows = plan;
      try { await app.ops.renameMany(dir, renameSteps(rows, others, WIN), rows.filter((x) => x.to !== x.from).length); } catch (err) {
        busy = false;
        return app.flash(`Could not rename: ${err} · the names were put back`);
      }
      app.closeOver();
      await Promise.all(app.panes.map((q) => q.refresh()));
      p.selected = new Set(rows.map((x) => dir + x.to)); p.paintCursor(false);
    };
    card.oninput = update;
    card.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); apply(); } };
    update(); find.focus();
  };

  document.querySelector('#btn-look').onclick = () => app.quickLook();
  document.querySelector('#btn-jump').onclick = () => app.jump();
  document.querySelector('#btn-palette').onclick = () => app.palette();
}
