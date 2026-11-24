'use strict';
/*
 * Minimal remote-channel example for an Electron app.
 *
 * A token-gated HTTP server (port 5175) living inside the app exposes:
 *   - assistant browsers: one WebContentsView per slot, own persistent
 *     partition, driven over HTTP (open / text / click / type / shot)
 *   - optional PC management (/pc/*), behind a separate in-app switch
 *
 * Two hard-won lessons are baked in (see ../README.md, section 7):
 *   1. A view that was never shown does not paint and does not lay out.
 *      Geometry/screenshot operations must light the view up and cover it
 *      with whatever the user is looking at (ensureBrowserPainted).
 *   2. Pages can contain hidden twin elements with the same selector.
 *      Always pick the first *visible* match (pickVisible).
 */
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const CHANNEL_PORT = 5175;
const TOP_BAR = 120; // px; the control panel occupies the top strip

// ---------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'channel-settings.json');
let settings = { enabled: false, token: '', pcEnabled: false };
function loadSettings() {
  try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch (e) {}
  if (!settings.token) { settings.token = crypto.randomBytes(24).toString('hex'); saveSettings(); }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) {}
}

// ------------------------------------------------------------------- audit
const auditRing = [];
function audit(kind, detail) {
  const line = { t: new Date().toISOString(), kind, detail: String(detail || '').slice(0, 300) };
  auditRing.push(line); if (auditRing.length > 300) auditRing.shift();
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'channel-audit.log'), JSON.stringify(line) + '\n'); } catch (e) {}
}

// ------------------------------------------------------------------- views
let win = null;
let coverView = null;          // plain page used to cover a lit browser view
const browserSlots = [{ id: 'main', name: 'Assistant main' }, { id: 'spare', name: 'Spare' }];
const browserViews = {};       // id -> WebContentsView (lazy)
let shownBrowserId = null;     // slot currently visible to the user, if any

function stageBounds() {
  const [w, h] = win.getContentSize();
  return { x: 0, y: TOP_BAR, width: w, height: Math.max(100, h - TOP_BAR) };
}
function getBrowserView(slot) {
  if (browserViews[slot.id]) return browserViews[slot.id];
  const view = new WebContentsView({
    webPreferences: { session: require('electron').session.fromPartition('persist:ocb-' + slot.id) },
  });
  view.setBounds(stageBounds());
  view.setVisible(false);
  win.contentView.addChildView(view);
  view.webContents.loadURL('https://www.bing.com/');
  browserViews[slot.id] = view;
  return view;
}
function getCoverView() {
  if (coverView) return coverView;
  coverView = new WebContentsView();
  coverView.setBounds(stageBounds());
  coverView.setVisible(false);
  win.contentView.addChildView(coverView);
  coverView.webContents.loadURL('data:text/html,<body style="font-family:sans-serif;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">Assistant at work...</body>');
  return coverView;
}
function showBrowser(id) {
  const slot = browserSlots.find(s => s.id === id);
  if (!slot) return;
  const view = getBrowserView(slot);
  for (const [k, v] of Object.entries(browserViews)) { try { v.setVisible(k === id); } catch (e) {} }
  try { getCoverView().setVisible(false); } catch (e) {}
  view.setBounds(stageBounds());
  win.contentView.removeChildView(view); win.contentView.addChildView(view); // re-top
  shownBrowserId = id;
}
function hideBrowsers() {
  for (const v of Object.values(browserViews)) { try { v.setVisible(false); } catch (e) {} }
  try { getCoverView().setVisible(false); } catch (e) {}
  shownBrowserId = null;
}

/*
 * Lesson 1: a never-shown view has no frames and no layout (screenshots are
 * empty, getBoundingClientRect is all zeros). Light the view up, cover it
 * with the cover page (in the real product: re-top the page the user is
 * watching), wait until the page really produced a frame, work, then
 * restore. Returns an "unpaint" function.
 */
async function ensureBrowserPainted(slot, view) {
  if (shownBrowserId === slot.id) return () => {};
  const cover = getCoverView();
  try {
    view.setBounds(stageBounds());
    view.setVisible(true);
    cover.setBounds(stageBounds());
    win.contentView.removeChildView(cover); win.contentView.addChildView(cover);
    cover.setVisible(true);
  } catch (e) {}
  await new Promise(r => setTimeout(r, 300));
  try {
    // requestAnimationFrame only fires when the page is actually painted;
    // a double rAF means at least one full frame was produced. A fixed
    // sleep is not enough on slow machines (cold layout can take >600ms).
    await view.webContents.executeJavaScript(
      'new Promise(r => { const t = setTimeout(() => r(false), 4500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); })', true);
  } catch (e) {}
  return () => { try { view.setVisible(false); } catch (e) {} try { cover.setVisible(false); } catch (e) {} };
}

// Lesson 2: pick the first *visible* element among all matches; pages ship
// hidden twins with the same id/selector and querySelector hits the twin.
const PICK_VISIBLE = `
  const pickVisible = (sel) => {
    const list = document.querySelectorAll(sel);
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden') return el;
    }
    return null;
  };`;

// ------------------------------------------------------------------ server
function tokenOk(req) {
  const got = Buffer.from(String(req.headers['x-oc-token'] || ''));
  const want = Buffer.from(String(settings.token || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 300 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function waitLoad(wc, ms) {
  return new Promise(resolve => {
    if (!wc.isLoading()) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wc.removeListener('did-stop-loading', done); resolve(); }
    wc.once('did-stop-loading', done);
  });
}

let channelServer = null;
function startChannelServer() {
  if (channelServer) return;
  channelServer = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!tokenOk(req)) return send(401, { error: 'bad token' });

      if (req.method === 'GET' && url.pathname === '/status') {
        return send(200, { ok: true, version: app.getVersion(), pc: settings.pcEnabled, browsers: browserSlots.length });
      }

      // ---------------------------------------------------- browsers
      if (req.method === 'GET' && url.pathname === '/browsers') {
        return send(200, browserSlots.map(s => {
          const v = browserViews[s.id];
          return { id: s.id, name: s.name, url: v ? v.webContents.getURL() : '', title: v ? v.webContents.getTitle() : '' };
        }));
      }
      const bm = url.pathname.match(/^\/browsers\/([^/]+)\/(open|text|click|type|shot|back|forward)$/);
      if (bm) {
        const slot = browserSlots.find(s => s.id === decodeURIComponent(bm[1]));
        if (!slot) return send(404, { error: 'no such browser slot' });
        const act = bm[2];
        const view = getBrowserView(slot);
        const wc = view.webContents;

        if (req.method === 'POST' && act === 'open') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          if (!body.url) return send(400, { error: 'url required' });
          audit('browser-open', slot.name + ' ' + body.url);
          await wc.loadURL(body.url).catch(() => {});
          await waitLoad(wc, 25000);
          return send(200, { ok: true, url: wc.getURL(), title: wc.getTitle() });
        }
        if (req.method === 'GET' && act === 'text') {
          const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""', true).catch(() => '');
          return send(200, { url: wc.getURL(), title: wc.getTitle(), text: String(text).slice(0, 30000) });
        }
        if (req.method === 'POST' && (act === 'back' || act === 'forward')) {
          if (act === 'back' && wc.canGoBack()) wc.goBack();
          if (act === 'forward' && wc.canGoForward()) wc.goForward();
          await waitLoad(wc, 15000);
          return send(200, { ok: true, url: wc.getURL(), title: wc.getTitle() });
        }
        if (req.method === 'POST' && act === 'click') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const fn = (selector, text) => {
            let el = null;
            if (selector) el = document.querySelector(selector);
            if (!el && text) el = [...document.querySelectorAll('a,button,[role=button],input,li,span,div')].find(e => (e.innerText || e.value || '').trim() === text);
            if (!el) return { ok: false, error: 'element not found' };
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
            for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              el.dispatchEvent(new MouseEvent(t, opts));
            }
            return { ok: true, tag: el.tagName };
          };
          const r = await wc.executeJavaScript(`(${fn})(${JSON.stringify(body.selector || '')}, ${JSON.stringify(body.text || '')})`, true).catch(e => ({ ok: false, error: String(e && e.message || e) }));
          if (r && r.ok) { audit('browser-click', slot.name); await waitLoad(wc, 12000); }
          return send(r && r.ok ? 200 : 404, Object.assign({}, r, { url: wc.getURL(), title: wc.getTitle() }));
        }
        if (req.method === 'POST' && act === 'type') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          if (typeof body.text !== 'string') return send(400, { error: 'text required' });
          const SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable="true"],[contenteditable=""]';
          const unpaint = await ensureBrowserPainted(slot, view);
          try {
            const probeFn = new Function('selector', 'dsel', `${PICK_VISIBLE}
              let el = selector ? pickVisible(selector) : null;
              if (!el) el = pickVisible(dsel);
              if (!el) { const any = (selector && document.querySelector(selector)) || document.querySelector(dsel);
                return any ? { tag: any.tagName, id: any.id || '', x: 0, y: 0, visible: false } : null; }
              el.scrollIntoView({ block: 'center' });
              const r = el.getBoundingClientRect();
              return { tag: el.tagName, id: el.id || '', x: r.left + r.width / 2, y: r.top + r.height / 2, visible: true };`);
            let info = null;
            for (let i = 0; i < 5; i++) {
              info = await wc.executeJavaScript(`(${probeFn})(${JSON.stringify(body.selector || '')}, ${JSON.stringify(SEL)})`, true).catch(() => null);
              if (info && info.visible) break;
              if (info && !info.tag) break;
              await new Promise(r => setTimeout(r, 500));
            }
            if (!info || !info.visible) return send(404, { ok: false, error: 'input not found or not visible', detail: info });
            const ix = Math.round(info.x), iy = Math.round(info.y);
            wc.sendInputEvent({ type: 'mouseDown', x: ix, y: iy, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x: ix, y: iy, button: 'left', clickCount: 1 });
            wc.insertText(body.text);
            const readFn = new Function('selector', 'dsel', `${PICK_VISIBLE}
              let el = selector ? pickVisible(selector) : null;
              if (!el) el = pickVisible(dsel);
              if (!el) return '';
              return ('value' in el) ? String(el.value || '') : String(el.innerText || el.textContent || '');`);
            let typed = String(await wc.executeJavaScript(`(${readFn})(${JSON.stringify(body.selector || '')}, ${JSON.stringify(SEL)})`, true).catch(() => '')).includes(body.text);
            if (!typed) { // fallback: native value setter + input/change events
              const setFn = new Function('selector', 'dsel', 'text', `${PICK_VISIBLE}
                let el = selector ? pickVisible(selector) : null;
                if (!el) el = pickVisible(dsel);
                if (!el) return false;
                el.focus();
                if ('value' in el) {
                  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
                } else { el.textContent = text; }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;`);
              await wc.executeJavaScript(`(${setFn})(${JSON.stringify(body.selector || '')}, ${JSON.stringify(SEL)}, ${JSON.stringify(body.text)})`, true).catch(() => false);
              typed = String(await wc.executeJavaScript(`(${readFn})(${JSON.stringify(body.selector || '')}, ${JSON.stringify(SEL)})`, true).catch(() => '')).includes(body.text);
            }
            if (body.submit) {
              wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
              wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
              await waitLoad(wc, 15000);
            }
            audit('browser-type', slot.name + ' len=' + body.text.length + ' typed=' + typed);
            return send(200, { ok: true, typed, url: wc.getURL(), title: wc.getTitle() });
          } finally { unpaint(); }
        }
        if (req.method === 'GET' && act === 'shot') {
          const unpaint = await ensureBrowserPainted(slot, view);
          let img = null;
          try {
            img = await wc.capturePage().catch(() => null);
            if (!img || img.isEmpty()) { await new Promise(r => setTimeout(r, 600)); img = await wc.capturePage().catch(() => null); }
          } finally { unpaint(); }
          if (!img || img.isEmpty()) return send(500, { error: 'empty capture' });
          const buf = img.toPNG();
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
          res.end(buf);
          return;
        }
        return send(405, { error: 'method not allowed' });
      }

      // ---------------------------------------------------------- PC
      if (url.pathname.startsWith('/pc/')) {
        if (!settings.pcEnabled) return send(403, { error: 'PC management is off. The user must enable it in the app.' });
        if (req.method === 'GET' && url.pathname === '/pc/info') {
          const os = require('os');
          return send(200, { hostname: os.hostname(), platform: process.platform, arch: process.arch, user: os.userInfo().username, home: os.homedir(), downloads: app.getPath('downloads') });
        }
        if (req.method === 'POST' && url.pathname === '/pc/exec') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          if (!body.cmd) return send(400, { error: 'cmd required' });
          audit('pc-exec', body.cmd);
          const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 60000, 1000), 300000);
          const fullCmd = process.platform === 'win32' ? 'chcp 65001>nul & ' + body.cmd : body.cmd;
          const out = await new Promise(resolve => {
            exec(fullCmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0), killed: !!(err && err.killed), stdout: String(stdout || '').slice(0, 60000), stderr: String(stderr || '').slice(0, 20000) });
            });
          });
          return send(200, out);
        }
        return send(404, { error: 'not found' });
      }

      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: String((e && e.message) || e) });
    }
  });
  channelServer.listen(CHANNEL_PORT, '0.0.0.0');
}
function stopChannelServer() { if (channelServer) { try { channelServer.close(); } catch (e) {} channelServer = null; } }

// --------------------------------------------------------------------- IPC
ipcMain.handle('settings-get', () => ({ enabled: settings.enabled, pcEnabled: settings.pcEnabled, token: settings.token, port: CHANNEL_PORT }));
ipcMain.handle('settings-set-enabled', (e, v) => { settings.enabled = !!v; saveSettings(); if (settings.enabled) startChannelServer(); else stopChannelServer(); return settings.enabled; });
ipcMain.handle('settings-set-pc-enabled', (e, v) => { settings.pcEnabled = !!v; saveSettings(); return settings.pcEnabled; });
ipcMain.handle('settings-regen', () => { settings.token = crypto.randomBytes(24).toString('hex'); saveSettings(); return settings.token; });
ipcMain.handle('channel-audit', () => auditRing.slice().reverse());
ipcMain.handle('browser-show', (e, id) => { showBrowser(id); });
ipcMain.handle('browser-hide', () => { hideBrowsers(); });

// --------------------------------------------------------------------- app
app.whenReady().then(() => {
  loadSettings();
  win = new BrowserWindow({
    width: 1100, height: 750,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile('index.html');
  win.on('resize', () => { for (const v of Object.values(browserViews)) { try { v.setBounds(stageBounds()); } catch (e) {} } if (coverView) { try { coverView.setBounds(stageBounds()); } catch (e) {} } });
  if (settings.enabled) startChannelServer();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
