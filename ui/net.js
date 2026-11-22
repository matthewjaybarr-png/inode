// Network places, phones and encrypted drives (Linux; mounts.rs does the work). A pane asked to open something that
// is not a folder yet (an address like smb://server/share, a plugged-in phone, a locked drive: isAddress in util.js)
// lands here: it is mounted first, asking for a sign-in or passphrase in a bar above the status line, and then
// opened as the folder it became. What is typed into those boxes goes to one command and is kept nowhere.
const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export const ADDRESS_HINT = 'Server address: smb://server/share · sftp://user@server/folder · ftp:// · dav:// · davs://   (Enter connects, Esc cancels)';
const PHONE_NOTE = 'The phone shows nothing yet: unlock its screen, allow file access (File transfer / MTP) on it, then press F5';

// "auth:user:matt" -> { user: 'matt' } (ask for a user name, offering that one) · "auth:password" -> {} (password only)
// "trust:<question>" -> { trust: question } · anything else -> null, a plain failure to show as it is.
// An address as it may be shown: a password typed into it ("ftp://kim:secret@box") is never repeated on screen.
export const shownAddress = (a) => a.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:]*):[^/@]*@/i, '$1@');

export function needs(error) {
  const s = String(error);
  if (s.startsWith('auth:user:')) return { user: s.slice(10) };
  if (s === 'auth:password') return {};
  if (s.startsWith('trust:')) return { trust: s.slice(6) };
  return null;
}

export function setupNet(app) {
  const refresh = () => invoke('places').then((p) => app.renderPlaces(p)).catch(() => {});

  // A bar above the status line with input boxes: resolves with their values, or null on Esc / Cancel.
  // The boxes are taken out of the page as soon as it closes.
  const fields = (message, specs) => new Promise((resolve) => {
    const box = document.querySelector('#prompt');
    if (!box.hidden) return resolve(null); // another question is still open: answer that one first
    const inputs = specs.map((s) => {
      const i = el('input', 'path-input');
      i.type = s.secret ? 'password' : 'text'; i.value = s.value || ''; i.placeholder = s.label;
      i.setAttribute('aria-label', s.label); i.spellcheck = false; i.autocomplete = 'off';
      return i;
    });
    const done = (ok) => {
      const values = ok ? inputs.map((i) => i.value) : null;
      box.onkeydown = null; box.replaceChildren(); box.hidden = true;
      app.pane().list.focus(); resolve(values);
    };
    const ok = el('button', 'primary', 'OK'), cancel = el('button', '', 'Cancel');
    ok.onclick = () => done(true); cancel.onclick = () => done(false);
    // Keys stay in the bar: Enter in a box answers, Esc cancels, and no pane command sees them.
    box.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); done(true); }
    };
    box.replaceChildren(el('span', 'msg', message), ...inputs, ok, cancel);
    box.hidden = false;
    (inputs.find((i) => !i.value) || inputs[0]).focus();
  });

  // Mounts an address; resolves with its folder, or null when the user backed out. Throws a plain reason otherwise.
  const connect = async (address, what) => {
    let user = null, password = null, trust = false;
    for (;;) {
      app.flash(`Connecting to ${what}…`);
      try { return await invoke('connect', { address, user, password, trust }); } catch (e) {
        const n = needs(e);
        if (!n) throw e;
        if (n.trust) {
          if (!(await app.ops.ask(`${n.trust} Connect anyway?`, [{ id: 'yes', label: 'Connect anyway', danger: true }, { id: null, label: 'Cancel', focus: true }]))) return null;
          trust = true;
        } else {
          const got = await fields(`Sign in to ${what}`, [...('user' in n ? [{ label: 'User name (DOMAIN\\name for a Windows domain)', value: user ?? n.user }] : []), { label: 'Password', secret: true }]);
          if (!got) return null;
          if ('user' in n) user = got[0];
          password = got[got.length - 1];
        }
      }
    }
  };

  app.net = {
    // True once the pane shows the folder, like Pane.go.
    async open(path, pane = app.pane()) {
      pane.closePath(); // before any box of ours opens: closing it later would take the focus away again
      if (path === 'connect:') {
        pane.editPath(); pane.input.value = ''; pane.input.placeholder = ADDRESS_HINT; pane.input.setAttribute('aria-label', 'Server address');
        return false;
      }
      const luks = path.startsWith('luks:'), vault = path.startsWith('vault:');
      const what = luks ? `the encrypted drive ${path.slice(5)}` : vault ? `the locked folder ${path.slice(6).split('/').pop()}` : shownAddress(path);
      try {
        let dir;
        if (vault) {
          const got = await fields(`Password for ${what}`, [{ label: 'Password', secret: true }]);
          if (!got) return false;
          app.flash(`Unlocking ${what}…`);
          dir = await invoke('unlock_folder', { folder: path.slice(6), password: got[0] });
        } else if (luks) {
          const got = await fields(`Passphrase for ${what}`, [{ label: 'Passphrase', secret: true }]);
          if (!got) return false;
          app.flash(`Unlocking ${what}…`);
          dir = await invoke('unlock', { device: path.slice(5), passphrase: got[0] });
        } else dir = await connect(path, what);
        if (dir == null) { app.flash('Not connected'); return false; }
        refresh();
        const ok = await pane.go(dir);
        if (ok) app.flash(/^(mtp|gphoto2|afc):/i.test(path) && !pane.entries.length ? PHONE_NOTE : `Opened ${what}`);
        return ok;
      } catch (e) {
        refresh(); // an unlock that could not mount still changed what the sidebar should show
        app.flash(`Could not open ${what}: ${e}`);
        return false;
      }
    },
    phoneNote: PHONE_NOTE,

    // New locked folder (gocryptfs, mounts.rs): name + password twice, then the recovery key, shown this once only.
    async newLocked(pane = app.pane()) {
      const where = pane.path;
      if (!where?.startsWith('/')) return app.flash('Open a folder first: the locked folder is made in it');
      let name = 'Private';
      for (;;) {
        const got = await fields(`New locked folder in ${where}. A forgotten password cannot be reset.`, [{ label: 'Folder name', value: name }, { label: 'Password', secret: true }, { label: 'Password again', secret: true }]);
        if (!got) return;
        name = got[0].trim();
        if (!name || !got[1]) { app.flash('Type a folder name and a password'); continue; }
        if (got[1] !== got[2]) { app.flash('The two passwords are not the same · type them again'); continue; }
        let made;
        try {
          app.flash(`Making the locked folder ${name}…`);
          made = await invoke('make_locked', { dir: where, name, password: got[1] });
        } catch (e) { app.flash(String(e)); continue; }
        await pane.go(where, { push: false, keep: made[0] });
        // The key opens the folder if the password is forgotten; it is shown here once and kept nowhere.
        for (;;) {
          const r = await app.ops.ask(`Recovery key for ${name}, shown only now. Save it somewhere safe: ${made[1]}`, [{ id: 'copy', label: 'Copy key' }, { id: 'done', label: 'I saved it', primary: true, focus: true }], { copy: (e) => e.key === 'c' });
          if (r !== 'copy') break;
          await navigator.clipboard.writeText(made[1]).then(() => app.flash('Recovery key copied'), (e) => app.flash(`Could not copy: ${e}`));
        }
        app.flash(`Made the locked folder ${name} · open it and type the password to use it`);
        return;
      }
    },
  };
}
