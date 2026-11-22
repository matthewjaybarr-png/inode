// App theme. The suite has one theme (default Neon Ridge) and each app may pick its own instead; both live in one
// small file the apps share. A choice is a bundled theme, "system" (the stylesheet's own light/dark colours, which
// follow Windows) or "desktop" (Omarchy's colors.toml on Linux, the Orbit / Omarchy Overlay theme on Windows; without one it
// falls back to "system").
// Only the app's own colours change: nothing here touches a document's content.

const hex = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim()); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const toHex = (rgb) => '#' + rgb.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => toHex(hex(a).map((x, i) => x + (hex(b)[i] - x) * t));
const lum = (c) => { const v = hex(c).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };

// shortcut: reads only flat `key = "value"` lines, which is all colors.toml uses.
export function parseColors(text) {
  const o = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

// CSS variables for a colors.toml; null when the theme lacks the basics.
export function themeVars(text) {
  const t = parseColors(text);
  const bg = t.background, fg = t.foreground, accent = t.accent || t.blue;
  if (!hex(bg) || !hex(fg) || !hex(accent)) return null;
  const dark = t.mode ? t.mode === 'dark' : lum(bg) < 0.4;
  const a = hex(accent);
  return {
    dark,
    vars: {
      '--bg': mix(bg, fg, 0.03), '--surface': bg, '--surface-2': mix(bg, fg, 0.06),
      '--border': mix(bg, fg, 0.16), '--border-strong': mix(bg, fg, 0.32),
      '--text': fg, '--muted': mix(fg, bg, 0.38), '--hover': mix(bg, fg, 0.09), '--press': mix(bg, accent, 0.28),
      '--accent': accent, '--accent-ink': lum(accent) > 0.45 ? '#111111' : '#ffffff',
      '--accent-soft': mix(bg, accent, 0.22), '--accent-hover': mix(accent, dark ? '#ffffff' : '#000000', 0.15),
      '--danger': hex(t.red) ? t.red : (dark ? '#F07A8C' : '#B3263E'),
      '--cell-bg': bg, '--cell-text': fg, '--grid-line': mix(bg, fg, 0.11),
      '--hdr-bg': mix(bg, fg, 0.06), '--hdr-text': mix(fg, bg, 0.38), '--hdr-line': mix(bg, fg, 0.16),
      '--hdr-sel-bg': mix(bg, accent, 0.25), '--hdr-sel-text': mix(accent, dark ? '#ffffff' : '#000000', 0.35),
      '--hdr-all-bg': mix(bg, fg, 0.12), '--sel-fill': `rgba(${a.join(', ')}, ${dark ? 0.18 : 0.12})`,
      '--freeze-line': mix(bg, fg, 0.45),
    },
  };
}

let applied = [];
function apply(theme) {
  const root = document.documentElement;
  for (const k of applied) root.style.removeProperty(k);
  applied = theme ? [...Object.keys(theme.vars), 'color-scheme'] : [];
  root.style.removeProperty('color-scheme');
  delete root.dataset.desktopTheme;
  if (!theme) return;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.style.setProperty('color-scheme', theme.dark ? 'dark' : 'light');
  root.dataset.desktopTheme = theme.dark ? 'dark' : 'light';
}

export const THEMES = ['aether', 'alpenglow-night', 'catppuccin', 'catppuccin-latte', 'ethereal', 'everforest', 'flexoki-light', 'gruvbox', 'hackerman', 'haunted-town', 'jade-horse', 'kanagawa', 'last-horizon', 'lumon', 'lupine', 'machine-shop', 'matte-black', 'miasma', 'neon-ridge', 'nord', 'purplemountain', 'retro-82', 'ristretto', 'rose-pine', 'solitude', 'starship', 'tokyo-night', 'vantablack', 'white'];
export const DEFAULT = 'neon-ridge';
// What an app shows: its own choice, else the suite's, else the default.
export const pick = (c) => c?.own || c?.suite || DEFAULT;
export const themeLabel = (id) => (id === 'system' ? 'Follow system (light / dark)' : id === 'desktop' ? 'Follow desktop'
  : id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));

const tauri = () => window.__TAURI__?.core?.invoke;
let recheck = () => {};

// Applies the chosen theme and keeps following it: the choice and the desktop theme are small file reads, polled so a
// change made in the Hub or another app shows up within a couple of seconds.
export function followDesktopTheme(onChange = () => {}) {
  const invoke = tauri();
  if (!invoke) return;
  let last;
  const check = async () => {
    let want = DEFAULT, text = null;
    try { want = pick(await invoke('theme_choice')); } catch { /* keep the default */ }
    try {
      if (want === 'desktop') {
        const d = await invoke('desktop_theme');
        if (d?.text) text = d.text;
        else if (d?.id && /^[a-z0-9-]+$/i.test(d.id)) want = d.id.toLowerCase();
      }
      if (!text && want !== 'system' && want !== 'desktop') { const r = await fetch(`themes/${want}.toml`); if (r.ok) text = await r.text(); }
    } catch { /* no such theme: keep the built-in look */ }
    if (text === last) return;
    last = text;
    apply(text && themeVars(text));
    onChange();
  };
  recheck = check;
  check();
  setInterval(check, 2000);
  addEventListener('focus', check);
}

// A small dialog: this app's theme and the suite's. Built with DOM calls only (no inline style attributes, which the
// built apps' CSP drops, and no confirm()/alert()).
export async function openThemePicker() {
  const invoke = tauri();
  if (!invoke || document.getElementById('theme-picker')) return;
  const el = (tag, css, text) => { const e = document.createElement(tag); e.style.cssText = css; if (text) e.textContent = text; return e; };
  let c = { suite: DEFAULT, own: null };
  try { c = await invoke('theme_choice'); } catch { /* show the defaults */ }
  const back = el('div', 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)');
  back.id = 'theme-picker';
  const card = el('div', 'min-width:320px;max-width:90vw;padding:18px 20px;border-radius:10px;background:var(--surface,#fff);color:var(--text,#111);border:1px solid var(--border-strong,var(--border,#888));box-shadow:0 12px 36px rgba(0,0,0,.35);font-size:14px');
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', 'Theme');
  const all = [DEFAULT, 'system', 'desktop', ...THEMES.filter((t) => t !== DEFAULT)];
  const row = (label, hint, scope, value, first) => {
    const wrap = el('label', 'display:block;margin:0 0 14px');
    const sel = el('select', 'display:block;width:100%;margin-top:4px;padding:5px 8px;border-radius:6px;font:inherit;background:var(--bg,#fff);color:var(--text,#111);border:1px solid var(--border-strong,var(--border,#888))');
    if (first) sel.append(new Option(first, ''));
    for (const id of all) sel.append(new Option(themeLabel(id), id));
    sel.value = value;
    sel.onchange = async () => {
      try { await invoke('set_theme_choice', { scope, value: sel.value || null }); } catch (e) { note.textContent = String(e); }
      recheck();
    };
    wrap.append(el('b', 'font-weight:600', label), sel, el('span', 'display:block;margin-top:3px;font-size:12px;color:var(--muted,#666)', hint));
    return [wrap, sel];
  };
  // No suite (public edition): one row for this app alone. A suite build's backend leaves `shared` out.
  const shared = c.shared !== false;
  const [own, ownSel] = shared
    ? row('This app', 'An own theme stays until you choose "Use the suite theme" again.', 'app', c.own || '', 'Use the suite theme')
    : row('App theme', '"Follow desktop" uses the Omarchy theme where there is one, else the system\'s light or dark.', 'app', pick(c));
  const rows = [own];
  if (shared) rows.push(row('Whole suite', 'Every app without its own theme follows this.', 'suite', c.suite || DEFAULT)[0]);
  const note = el('div', 'font-size:12px;color:var(--muted,#666);margin-bottom:12px', shared
    ? 'Only the app changes colour. Documents, sheets, PDFs and slides keep their own colours, on screen and in print.'
    : 'Only the app changes colour. Previews keep the files\' own colours.');
  const close = el('button', 'padding:5px 16px;border-radius:6px;font:inherit;background:var(--accent,#06c);color:var(--accent-ink,#fff);border:1px solid var(--accent,#06c);float:right', 'Close');
  close.type = 'button';
  const shut = () => back.remove();
  close.onclick = shut;
  back.onmousedown = (e) => { if (e.target === back) shut(); };
  back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); shut(); } });
  card.append(el('div', 'font-size:16px;font-weight:600;margin-bottom:14px', 'Theme'), ...rows, note, close);
  back.append(card); document.body.append(back);
  ownSel.focus();
}

// DEV channel: a DEV build's product name ends in " DEV" (scripts/dev-config.sh). Every window title and the
// app's own heading then carry the label; a release build is left exactly as it was.
globalThis.window?.__TAURI__?.app?.getName?.().then((name) => {
  if (!/ DEV$/.test(name)) return;
  const W = window.__TAURI__.window.Window.prototype, set = W.setTitle;
  W.setTitle = function (t) { return set.call(this, / DEV$/.test(t) ? t : `${t} DEV`); };
  const w = window.__TAURI__.window.getCurrentWindow();
  w.title().then((t) => w.setTitle(t)).catch(() => {});
  const s = document.createElement('style');
  s.textContent = '.bs-main h2::after, .brand b::after { content: " DEV"; }';
  document.head.append(s);
}).catch(() => {});
