import { CALLS, CONTACT_TYPES, MAX_LINEUP, PITCH_CODES, lineupSize, replay, autoResult, undo, guessContact, sprayZone } from './engine.js';
import { chartSVG, pageCount } from './chart.js';
import * as store from './store.js';
import { stats, playerHistory, filterRows, toCsv } from './stats.js';

const root = document.getElementById('app');
const uid = () => crypto.randomUUID();

// Tagged template that escapes every value unless it is already safe markup.
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const value = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(value).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
};
const h = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? value(vals[i]) : ''), ''));
const safe = (s) => new Safe(s);

const TYPES = { game: 'Game', live: 'Live', scrimmage: 'Scrimmage', bullpen: 'Bullpen' };
const QUICK_RESULTS = [
  ['Hits', ['1B', '2B', '3B', 'HR']],
  ['Ground', ['1-3', '3U', '4-3', '5-3', '6-3']],
  ['Air', ['F7', 'F8', 'F9', 'F3', 'L6', 'P4']],
  ['Other', ['E6', 'FC', 'SAC', 'SF', '6-4-3 DP', 'K', 'KL', 'KWP']],
];
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');
const avg = (n, d) => (d ? (n / d).toFixed(3).replace(/^0/, '') : '–');
const ip = (outs) => `${Math.floor((outs || 0) / 3)}.${(outs || 0) % 3}`;

// Per-charting-screen state; not saved.
const ui = {
  mode: localStorage.getItem('wgc.mode') || (window.innerWidth >= 900 ? 'both' : 'record'),
  pitchType: null, loc: null, editing: null, sheet: null, showLog: false,
};
const resetEntry = () => { ui.pitchType = null; ui.loc = null; ui.editing = null; };

let screen = { render() {} };

function syncBadge() {
  const n = store.pending();
  const st = store.status;
  let label = n ? `${n} waiting to sync` : 'All saved';
  let alert = false;
  if (st.state === 'offline' && n) { label = `Offline · ${n} saved on device`; }
  if (st.state === 'signin') { label = 'Sign in to sync'; alert = true; }
  if (st.storageFull) { label = 'Device storage full'; alert = true; }
  return st.state === 'signin' ? h`<a class="sync alert" href="#/login">${label}</a>` : h`<span class="sync ${alert ? 'alert' : ''}" data-testid="sync">${label}</span>`;
}

function topbar(title) {
  return h`<header class="topbar">
    <h1><a href="#/" style="text-decoration:none">${title}</a></h1>
    <span class="spacer"></span>
    <nav class="navlinks" aria-label="Main">
    <a class="navlink" href="#/">Home</a>
    <a class="navlink" href="#/stats">Stats</a>
    <a class="navlink" href="#/roster">Roster</a>
    </nav>
    <span id="sync-slot">${syncBadge()}</span>
  </header>`;
}

// ---------- Home ----------
async function homeScreen() {
  let list = [];
  const render = () => {
    root.innerHTML = h`${topbar('Wabash Charting')}
    <main class="page">
      <div class="row between" style="margin-bottom:.8rem">
        <h2 style="margin:0">Sessions</h2>
        <a class="btn primary" href="#/new">New chart</a>
      </div>
      <section class="card">
        ${list.length ? list.map((s) => h`<div class="session-row"><a class="session-link" href="#/session/${s.id}">
          <span><strong>${s.opponent || '(no opponent)'}</strong> <span class="tag">${TYPES[s.type] || s.type}</span><br>
          <span class="muted">${s.pitchers || 'No pitcher set'}</span></span>
          <span class="muted" style="text-align:right">${s.date}<br>${s.pitch_count} pitches</span></a>
          <button class="small danger" data-delete="${s.id}" aria-label="Delete the ${s.date} chart">Delete</button></div>`) : h`<p class="muted">No charts yet. Start one with “New chart”.</p>`}
      </section>
    </main>`;
    root.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
      const s = list.find((x) => x.id === b.dataset.delete);
      if (!confirm(`Delete the ${s.date} chart${s.opponent ? ` (${s.opponent})` : ''}? Its ${s.pitch_count} pitches will be removed from the stats and the Sheet.`)) return;
      if (!await store.deleteSession(s.id)) {
        alert('This chart can\'t be reached right now. Try again with a connection.');
        return;
      }
      list = list.filter((x) => x.id !== s.id);
      render();
    }));
  };
  screen = { render };
  render();
  list = await store.listSessions();
  if (location.hash === '' || location.hash === '#/') render();
}

// ---------- New / edit session ----------
async function setupScreen(id) {
  const existing = id ? await store.loadSession(id) : null;
  if (id && !existing) {
    root.innerHTML = h`${topbar('Edit chart')}<main class="page"><p class="error">This chart isn't on this device and the Google Sheet can't be reached.</p></main>`;
    return;
  }
  const data = store.getData();
  const session = existing || { id: uid(), createdAt: Date.now(), date: today(), type: 'scrimmage', opponent: '', pitcher: '', notes: '', lineup: [], events: [] };
  const players = data.players;
  const draft = [...session.lineup]; // Holds names for spots hidden by a smaller size.
  let setNames = Boolean(id) || session.type === 'game';
  let modeTouched = Boolean(id);
  const lineupRows = (lineup, size) => Array.from({ length: size }, (_, i) => {
    const p = lineup[i] || {};
    return h`<div class="lineup-row">
      <span class="muted">${i + 1}</span>
      <input name="name${i}" list="players" placeholder="Batter name" value="${p.name || ''}" aria-label="Batter ${i + 1} name" autocomplete="off">
      <input name="number${i}" placeholder="#" value="${p.number || ''}" aria-label="Batter ${i + 1} number">
      <select name="hand${i}" aria-label="Batter ${i + 1} side">${['', 'R', 'L', 'S'].map((o) => h`<option ${p.hand === o ? safe('selected') : ''}>${o}</option>`)}</select>
    </div>`;
  });
  const render = () => {
    root.innerHTML = h`${topbar(id ? 'Edit chart' : 'New chart')}
    <main class="page">
      <form id="setup">
        <section class="card form-grid">
          <label>Date<input type="date" name="date" required value="${session.date}"></label>
          <label>Type<select name="type">${Object.entries(TYPES).map(([k, v]) => h`<option value="${k}" ${session.type === k ? safe('selected') : ''}>${v}</option>`)}</select></label>
          <label>Opponent<input name="opponent" placeholder="Opponent or LIVE" value="${session.opponent}"></label>
          <label>Starting pitcher<input name="pitcher" list="players" required placeholder="Pitcher" value="${session.pitcher}" autocomplete="off"></label>
          <label>Batters in lineup<select name="size">${Array.from({ length: MAX_LINEUP }, (_, i) => i + 1).map((n) => h`<option value="${n}" ${lineupSize(session) === n ? safe('selected') : ''}>${n}</option>`)}</select></label>
        </section>
        <section class="card">
          <h2>Batter names</h2>
          <div class="row" role="radiogroup" aria-label="Batter names">
            <label class="choice"><input type="radio" name="lineupMode" value="asWeGo" ${setNames ? '' : safe('checked')}> Fill in as we go</label>
            <label class="choice"><input type="radio" name="lineupMode" value="preset" ${setNames ? safe('checked') : ''}> Set the lineup now</label>
          </div>
          <div id="preset" ${setNames ? '' : safe('hidden')} style="margin-top:.7rem">
            <div class="row between">
              <p class="muted" style="margin:0">Name, number, and side (R/L/S). Blank spots can be filled in later.</p>
              <button type="button" class="small" data-act="copy-last">Copy last lineup</button>
            </div>
            <div id="rows" style="margin-top:.5rem">${lineupRows(session.lineup, lineupSize(session))}</div>
          </div>
        </section>
        <p class="error" id="setup-error" role="alert"></p>
        <div class="row"><button class="primary grow" type="submit">${id ? 'Save changes' : 'Start charting'}</button>
        ${id && h`<button type="button" class="danger" data-act="delete">Delete chart</button>`}</div>
      </form>
      <datalist id="players">${players.map((p) => h`<option value="${p.name}"></option>`)}</datalist>
    </main>`;
    const form = root.querySelector('#setup');
    const readLineup = (size) => {
      const f = new FormData(form);
      return Array.from({ length: size }, (_, i) => ({
        name: (f.get(`name${i}`) || '').trim(), number: (f.get(`number${i}`) || '').trim(), hand: f.get(`hand${i}`) || '',
      }));
    };
    const showMode = (preset) => {
      root.querySelector('#preset').hidden = !preset;
      form.elements.lineupMode.value = preset ? 'preset' : 'asWeGo';
    };
    form.elements.size.addEventListener('change', (e) => {
      const shown = root.querySelectorAll('.lineup-row').length;
      readLineup(shown).forEach((p, i) => { draft[i] = p; });
      root.querySelector('#rows').innerHTML = lineupRows(draft, Number(e.target.value)).join('');
    });
    form.querySelectorAll('[name=lineupMode]').forEach((r) => r.addEventListener('change', () => {
      modeTouched = true;
      showMode(form.elements.lineupMode.value === 'preset');
    }));
    form.elements.type.addEventListener('change', (e) => {
      // Games usually have a set lineup. Scrimmages usually fill in as they go.
      if (!modeTouched) showMode(e.target.value === 'game');
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const size = Number(f.get('size'));
      const spotsUsed = replay(session).atBats.reduce((m, ab) => Math.max(m, ab.slot + 1), 0);
      if (size < spotsUsed) {
        root.querySelector('#setup-error').textContent = `Spot ${spotsUsed} already has at-bats, so the lineup can't be smaller than ${spotsUsed}.`;
        return;
      }
      Object.assign(session, {
        date: f.get('date'), type: f.get('type'), opponent: f.get('opponent').trim(), pitcher: f.get('pitcher').trim(),
        lineupSize: size,
        lineup: readLineup(size),
      });
      store.save(session);
      location.hash = `#/session/${session.id}`;
    });
    root.querySelector('[data-act=copy-last]').addEventListener('click', async (e) => {
      const list = await store.listSessions();
      const last = list.find((s) => s.id !== session.id && s.type === root.querySelector('[name=type]').value) || list.find((s) => s.id !== session.id);
      const source = last && await store.loadSession(last.id);
      if (!source) { e.target.textContent = 'No earlier lineup'; return; }
      const size = lineupSize(source);
      form.elements.size.value = String(size);
      draft.splice(0, draft.length, ...source.lineup);
      root.querySelector('#rows').innerHTML = lineupRows(draft, size).join('');
    });
    root.querySelector('[data-act=delete]')?.addEventListener('click', () => {
      if (!confirm('Delete this chart and all of its pitches from the stats?')) return;
      session.deleted = true;
      store.save(session);
      location.hash = '#/';
    });
  };
  screen = { render() {} }; // Don't redraw a half-filled form on sync updates.
  render();
}

// ---------- Charting ----------
function ensureStateFor(session) {
  session.events ||= [];
  return replay(session);
}

function zonePad(ab) {
  const toPx = (v) => 75 + v * 150;
  const marks = (ab?.pitches || []).filter((p) => p.x != null && p.id !== ui.editing).map((p) => h`
    <text x="${toPx(p.x)}" y="${toPx(p.y) + 5}" font-size="15" font-weight="700" text-anchor="middle" fill="#5b616e">${p.n}</text>`);
  const lines = [125, 175].map((v) => h`<line x1="${v}" y1="75" x2="${v}" y2="225" stroke="#ddd"/><line x1="75" y1="${v}" x2="225" y2="${v}" stroke="#ddd"/>`);
  return h`<svg class="zonepad" id="zone" viewBox="0 0 300 300" role="img" aria-label="Strike zone, catcher's view. Tap where the pitch crossed.">
    <rect x="75" y="75" width="150" height="150" fill="#fafafa" stroke="#111" stroke-width="2.5"/>
    ${lines}${marks}
    ${ui.loc && h`<circle cx="${toPx(ui.loc.x)}" cy="${toPx(ui.loc.y)}" r="11" fill="#a6192e" fill-opacity=".85"/>`}
    <text x="150" y="292" font-size="12" text-anchor="middle" fill="#5b616e">Catcher's view</text>
  </svg>`;
}

function describeEvent(ev, codes) {
  const label = (c) => codes.find((x) => x.code === c)?.label || `Type ${c}`;
  if (ev.kind === 'pitch') return `${label(ev.pitchType)} · ${CALLS[ev.call]}${ev.x == null ? ' · no location' : ''}`;
  if (ev.kind === 'result') {
    const extra = [ev.contact, ev.spray && sprayZone(ev.spray.x, ev.spray.y)].filter(Boolean).map((t) => ` · ${t}`).join('');
    return `Result: ${ev.code || 'none recorded'}${ev.barrel ? ' ★' : ''}${extra}`;
  }
  if (ev.kind === 'pitcher') return `Pitching change: ${ev.name}`;
  if (ev.kind === 'sub') return `Sub in spot ${ev.slot + 1}: ${ev.name}`;
  return 'Inning ended';
}

function resultSheet(session, st) {
  const editing = ui.sheet.editId ? session.events.find((e) => e.id === ui.sheet.editId) : null;
  const batter = st.state.lineup[st.state.slot]?.name;
  const ab = editing ? st.atBats.find((a) => a.resultId === editing.id) : st.current;
  const inPlay = ab?.pitches.at(-1)?.call === 'inplay';
  return h`<div class="sheet-backdrop" data-act="sheet-cancel-bg"><div class="sheet" role="dialog" aria-label="At-bat result">
    <h2>${editing ? 'Change result' : `Result${batter ? ` for ${batter}` : ''}`}</h2>
    ${inPlay && h`<button class="barrel-toggle ${ui.sheet.barrel ? 'on' : ''}" data-act="toggle-barrel" aria-pressed="${Boolean(ui.sheet.barrel)}">★ Barreled</button>`}
    ${QUICK_RESULTS.map(([label, codes]) => h`<div class="section-label">${label}</div>
      <div class="chips">${codes.map((c) => h`<button data-act="result-chip" data-code="${c}">${c}</button>`)}</div>`)}
    <label>Or type it, e.g. 1B8, 6-3, F9
      <input id="result-code" value="${editing?.code || ''}" autocapitalize="characters" autocomplete="off">
    </label>
    <div class="row" style="margin-top:.6rem">
      <button class="primary grow" data-act="result-save">Save result</button>
      <button data-act="sheet-cancel">Cancel</button>
    </div>
  </div></div>`;
}

// The field from behind home plate, to scale with the fence at 330 feet. Spots are kept in feet.
const FIELD_SCALE = 200 / 330;
const HOME_X = 150;
const HOME_Y = 245;
const BASE = (x, y) => h`<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="#fff" stroke="#8a8f99" transform="rotate(45 ${x} ${y})"/>`;

function fieldPad(spray) {
  return h`<svg class="fieldpad" id="field" viewBox="0 0 300 260" role="img" aria-label="Field from behind home plate. Tap where the ball ended up.">
    <path d="M150,245 L8.6,103.6 A200,200 0 0 1 291.4,103.6 Z" fill="#d3e8c4" stroke="#7a9a6a" stroke-width="1.5"/>
    <path d="M150,245 L95.3,190.3 A57.6,57.6 0 0 1 204.7,190.3 Z" fill="#e6cfa8"/>
    <polygon points="150,245 188.6,206.4 150,167.9 111.4,206.4" fill="#d3e8c4" stroke="#fff" stroke-width="2"/>
    <circle cx="150" cy="208.3" r="5" fill="#e6cfa8"/>
    ${BASE(188.6, 206.4)}${BASE(150, 167.9)}${BASE(111.4, 206.4)}
    <polygon points="146,241 154,241 154,245 150,249 146,245" fill="#fff" stroke="#8a8f99"/>
    ${[['LF', 62, 128], ['CF', 150, 78], ['RF', 238, 128]].map(([t, x, y]) => h`<text x="${x}" y="${y}" font-size="13" text-anchor="middle" fill="#6f8a62">${t}</text>`)}
    ${spray && h`<circle cx="${HOME_X + spray.x * FIELD_SCALE}" cy="${HOME_Y - spray.y * FIELD_SCALE}" r="8" fill="#a6192e" fill-opacity=".9" stroke="#fff" stroke-width="2"/>`}
  </svg>`;
}

function battedSheet(session) {
  const ev = session.events.find((e) => e.id === ui.sheet.resultId);
  const zone = ui.sheet.spray && sprayZone(ui.sheet.spray.x, ui.sheet.spray.y);
  return h`<div class="sheet-backdrop" data-act="sheet-cancel-bg"><div class="sheet" role="dialog" aria-label="Ball in play">
    <h2>Ball in play${ev?.code ? `: ${ev.code}` : ''}</h2>
    <div class="contact-pick" role="group" aria-label="How it was hit">${CONTACT_TYPES.map(([code, label]) => h`<button class="${ui.sheet.contact === code ? 'on' : ''}" data-act="set-contact" data-v="${code}" aria-pressed="${ui.sheet.contact === code}">${label}</button>`)}</div>
    <div class="section-label">${zone ? `Ended up: ${zone}` : 'Tap where the ball ended up'}</div>
    ${fieldPad(ui.sheet.spray)}
    <div class="row" style="margin-top:.6rem">
      <button class="primary grow" data-act="batted-save">Save</button>
      <button data-act="sheet-cancel">Skip</button>
    </div>
  </div></div>`;
}

function subSheet() {
  return h`<div class="sheet-backdrop"><form class="sheet" id="sub-form" aria-label="Substitution">
    <h2>Substitution</h2>
    <div class="form-grid">
      <label>Lineup spot<input name="slot" type="number" min="1" max="${ui.sheet.size}" required value="${ui.sheet.slot + 1}"></label>
      <label>New batter<input name="name" list="players" required autocomplete="off"></label>
      <label>Number<input name="number"></label>
      <label>Side<select name="hand">${['', 'R', 'L', 'S'].map((o) => h`<option>${o}</option>`)}</select></label>
    </div>
    <div class="row" style="margin-top:.6rem"><button class="primary grow">Save sub</button><button type="button" data-act="sheet-cancel">Cancel</button></div>
  </form></div>`;
}

function pitcherSheet() {
  return h`<div class="sheet-backdrop"><form class="sheet" id="pitcher-form" aria-label="Pitching change">
    <h2>Pitching change</h2>
    <label>New pitcher<input name="name" required list="players" autocomplete="off"></label>
    <div class="row" style="margin-top:.6rem"><button class="primary grow">Save</button><button type="button" data-act="sheet-cancel">Cancel</button></div>
  </form></div>`;
}

function recordPane(session, st) {
  const { state, current, warnings } = st;
  const codes = PITCH_CODES;
  const batter = state.lineup[state.slot] || {};
  const lastEv = session.events[session.events.length - 1];
  const awaitingResult = lastEv?.kind === 'pitch' && lastEv.call === 'inplay';
  const editingEv = ui.editing && session.events.find((e) => e.id === ui.editing);
  const unnamedSpots = [...new Set(st.atBats.filter((ab) => !ab.batter && ab.result !== null).map((ab) => ab.slot + 1))]
    .filter((spot) => spot !== state.slot + 1 && !state.lineup[spot - 1]?.name).sort((a, b) => a - b);
  const canCommit = ui.pitchType != null;
  return h`<section class="record-pane">
    ${warnings.map((w) => h`<div class="warnbox" role="status">${w.text}. Fix the pitch or the result in the log below.</div>`)}
    ${unnamedSpots.length > 0 && h`<div class="warnbox" role="status">No name yet for ${unnamedSpots.length > 1 ? 'spots' : 'spot'} ${unnamedSpots.join(', ')}. Their at-bats need one for the stats and CSV. <a href="#/edit/${session.id}">Add names</a></div>`}
    ${store.status.storageFull && h`<div class="warnbox" role="alert">This device is out of storage. Reconnect so waiting charts can sync.</div>`}
    <div class="card">
      ${editingEv ? h`<div class="warnbox">Editing a pitch. Change it below, then pick its outcome. <button class="small" data-act="edit-cancel">Cancel edit</button></div>` : h`
      ${batter.name ? h`<div class="batter-line">
        <span class="muted">Spot ${state.slot + 1} of ${state.size}</span>
        <strong data-testid="batter">${batter.number ? `#${batter.number} ` : ''}${batter.name}</strong>
        <span class="muted">vs. ${state.pitcher || 'no pitcher set'}</span>
      </div>` : h`<div class="batter-entry">
        <span class="muted">Spot ${state.slot + 1} of ${state.size} · vs. ${state.pitcher || 'no pitcher set'}</span>
        <div class="batter-inputs">
          <input id="batter-name" list="players" placeholder="Who's batting?" aria-label="Batter name" autocomplete="off">
          <input id="batter-number" placeholder="#" aria-label="Batter number" value="${batter.number || ''}" autocomplete="off">
        </div>
      </div>`}
      <div class="row" style="margin-top:.3rem">
        <span class="pick" role="group" aria-label="Batter side">${['R', 'L', 'S'].map((o) => h`<button class="${batter.hand === o ? 'on' : ''}" data-act="set-hand" data-v="${o}" aria-pressed="${batter.hand === o}">${o}</button>`)}</span>
      </div>`}
      ${zonePad(editingEv ? st.atBats.find((ab) => ab.pitches.some((p) => p.id === ui.editing)) : current)}
      <div class="section-label">Pitch type</div>
      <div class="btn-grid types">${codes.map((c) => h`<button class="${ui.pitchType === c.code ? 'on' : ''}" data-act="type" data-code="${c.code}" aria-pressed="${ui.pitchType === c.code}">${c.code} ${c.label}</button>`)}</div>
      <div class="section-label">${canCommit ? (ui.loc ? 'Outcome logs the pitch' : 'Outcome logs the pitch (no location tapped yet)') : 'Pick a pitch type first'}</div>
      <div class="btn-grid calls">
        <button class="c-ball" data-act="call" data-call="ball" ${canCommit ? '' : safe('disabled')}>Ball</button>
        <button class="c-strike" data-act="call" data-call="called" ${canCommit ? '' : safe('disabled')}>Called strike</button>
        <button class="c-strike" data-act="call" data-call="swinging" ${canCommit ? '' : safe('disabled')}>Whiff</button>
        <button data-act="call" data-call="foul" ${canCommit ? '' : safe('disabled')}>Foul</button>
        <button data-act="call" data-call="inplay" ${canCommit ? '' : safe('disabled')}>In play</button>
        <button data-act="call" data-call="hbp" ${canCommit ? '' : safe('disabled')}>Hit by pitch</button>
      </div>
      <div class="row" style="margin-top:.55rem">
        ${awaitingResult && h`<button class="primary grow" data-act="open-result">Enter result</button>`}
        <button class="grow" data-act="undo" ${session.events.length ? '' : safe('disabled')}>Undo last</button>
        <button class="grow" data-act="open-result">Result…</button>
      </div>
    </div>

    <div class="card row">
      <button class="grow" data-act="end-inning">End inning</button>
      <button class="grow" data-act="no-result">Next batter</button>
      <button class="grow" data-act="open-pitcher">Pitching change</button>
      <button class="grow" data-act="open-sub">Sub batter</button>
    </div>

    <div class="card">
      <label>Game notes<textarea id="notes">${session.notes || ''}</textarea></label>
      <div class="row" style="margin-top:.5rem">
        <button class="grow" data-act="toggle-log">${ui.showLog ? 'Hide' : 'Show'} log (${session.events.length})</button>
        <a class="btn grow" href="#/edit/${session.id}">Edit lineup / details</a>
      </div>
      ${ui.showLog && [...session.events].reverse().map((ev) => h`<div class="logrow ${ui.editing === ev.id ? 'editing' : ''}">
        <span>${describeEvent(ev, codes)}</span>
        <span class="row">
          ${(ev.kind === 'pitch' || ev.kind === 'result') && h`<button class="small" data-act="edit-event" data-id="${ev.id}">Edit</button>`}
          <button class="small danger" data-act="delete-event" data-id="${ev.id}" aria-label="Delete: ${describeEvent(ev, codes)}">Delete</button>
        </span></div>`)}
    </div>
  </section>`;
}

function chartScreen(id) {
  let session = store.getLocal(id);
  let typedSaveTimer;
  const commit = () => {
    clearTimeout(typedSaveTimer);
    store.save(session);
    render();
  };
  // Typing a batter's name must not redraw the screen: a redraw mid-tap would lose the tap
  // that closes the phone keyboard. Only the chart updates, and the save waits for a pause.
  const redrawChart = () => {
    const st = ensureStateFor(session);
    const pane = root.querySelector('.chart-pane');
    if (pane) pane.innerHTML = Array.from({ length: pageCount(st) }, (_, p) => chartSVG(session, st, p)).join('');
  };
  const saveTypedBatter = () => {
    redrawChart();
    clearTimeout(typedSaveTimer);
    typedSaveTimer = setTimeout(() => store.save(session), 600);
  };

  const logPitch = (call, st) => {
    const fields = { pitchType: ui.pitchType, call, x: ui.loc?.x ?? null, y: ui.loc?.y ?? null };
    if (ui.editing) {
      const ev = session.events.find((e) => e.id === ui.editing);
      if (ev) Object.assign(ev, fields);
      resetEntry();
      commit();
      return;
    }
    const pitch = { id: uid(), kind: 'pitch', ...fields };
    const auto = autoResult(st.state, call);
    session.events.push(pitch);
    if (auto) session.events.push({ id: uid(), kind: 'result', code: auto, auto: true, byPitch: pitch.id });
    resetEntry();
    if (call === 'inplay') ui.sheet = { kind: 'result' };
    commit();
  };

  const render = () => {
    if (!session) return;
    const st = ensureStateFor(session);
    const { state } = st;
    const pages = pageCount(st);
    const scrollY = window.scrollY;
    const paneScroll = root.querySelector('.chart-pane')?.scrollTop;
    const dots = (n, total) => h`<span class="dots">${Array.from({ length: total }, (_, i) => h`<span class="dot ${i < n ? 'fill' : ''}"></span>`)}</span>`;
    const modes = [['record', 'Record'], ['both', 'Both'], ['chart', 'Chart']];
    const showRecord = ui.mode !== 'chart';
    const showChart = ui.mode !== 'record';
    const notesActive = document.activeElement?.id === 'notes';
    root.innerHTML = h`<div class="chart-screen">
      ${topbar(`${session.opponent || 'Chart'} · ${session.date}`)}
      <div class="scorebar" aria-live="polite">
        <span><span class="lbl">Inn</span><b data-testid="inning">${state.inning}</b></span>
        <span><span class="lbl">Count</span><b data-testid="count">${state.balls}-${Math.min(state.strikes, 2)}</b></span>
        <span aria-label="${state.outs} outs"><span class="lbl">Outs</span>${dots(state.outs, 2)}</span>
        <span style="flex:1"></span>
        <span class="modes" role="group" aria-label="View">${modes.map(([k, v]) => h`<button class="${ui.mode === k ? 'on' : ''}" data-act="mode" data-v="${k}" aria-pressed="${ui.mode === k}">${v}</button>`)}</span>
        <button class="small" data-act="print" style="color:var(--ink)">PDF / Print</button>
      </div>
      <div class="workspace ${ui.mode === 'both' ? 'both' : ui.mode === 'chart' ? 'chart-only' : ''}">
        ${showRecord && recordPane(session, st)}
        <div class="chart-pane ${showChart ? '' : 'screen-hidden'}" data-testid="chart">${Array.from({ length: pages }, (_, p) => safe(chartSVG(session, st, p)))}</div>
      </div>
    </div>
    <datalist id="players">${store.getData().players.map((p) => h`<option value="${p.name}"></option>`)}</datalist>
    ${ui.sheet?.kind === 'result' && resultSheet(session, st)}
    ${ui.sheet?.kind === 'batted' && battedSheet(session)}
    ${ui.sheet?.kind === 'sub' && subSheet()}
    ${ui.sheet?.kind === 'pitcher' && pitcherSheet()}`;
    window.scrollTo(0, scrollY);
    const pane = root.querySelector('.chart-pane');
    if (pane && paneScroll != null) pane.scrollTop = paneScroll;

    root.querySelector('#notes')?.addEventListener('change', (e) => { session.notes = e.target.value; commit(); });
    root.querySelector('#batter-name')?.addEventListener('input', (e) => {
      const name = e.target.value.trim();
      setBatterValue('name', name);
      // A roster name also fills in the number and side, if they're blank.
      const known = store.getData().players.find((p) => p.name === name);
      const numberInput = root.querySelector('#batter-number');
      const { state } = ensureStateFor(session);
      if (known && !numberInput.value) {
        numberInput.value = known.number || '';
        setBatterValue('number', numberInput.value);
      }
      if (known?.bats && !state.lineup[state.slot].hand) {
        setBatterValue('hand', known.bats);
        root.querySelectorAll('[data-act=set-hand]').forEach((b) => {
          b.classList.toggle('on', b.dataset.v === known.bats);
          b.setAttribute('aria-pressed', String(b.dataset.v === known.bats));
        });
      }
      saveTypedBatter();
    });
    root.querySelector('#batter-number')?.addEventListener('input', (e) => {
      setBatterValue('number', e.target.value.trim());
      saveTypedBatter();
    });
    root.querySelectorAll('#batter-name, #batter-number').forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    }));
    if (notesActive) root.querySelector('#notes')?.focus();
    root.querySelector('#zone')?.addEventListener('click', (e) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * 300;
      const py = ((e.clientY - rect.top) / rect.height) * 300;
      ui.loc = { x: Number(((px - 75) / 150).toFixed(3)), y: Number(((py - 75) / 150).toFixed(3)) };
      render();
    });
    root.querySelector('#field')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * 300;
      const py = ((e.clientY - rect.top) / rect.height) * 260;
      ui.sheet.spray = { x: Math.round((px - HOME_X) / FIELD_SCALE), y: Math.round((HOME_Y - py) / FIELD_SCALE) };
      render();
    });
    root.querySelector('#sub-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const slot = Number(f.get('slot')) - 1;
      session.events.push({ id: uid(), kind: 'sub', slot, name: f.get('name').trim(), number: f.get('number').trim(), hand: f.get('hand') });
      ui.sheet = null;
      commit();
    });
    root.querySelector('#pitcher-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      session.events.push({ id: uid(), kind: 'pitcher', name: new FormData(e.target).get('name').trim() });
      ui.sheet = null;
      commit();
    });
  };

  const saveResult = (code) => {
    const st = ensureStateFor(session);
    const barrel = Boolean(ui.sheet.barrel);
    const ab = ui.sheet.editId ? st.atBats.find((a) => a.resultId === ui.sheet.editId) : st.current;
    let ev = null;
    if (ui.sheet.editId) {
      ev = session.events.find((e) => e.id === ui.sheet.editId);
      if (ev) { ev.code = code; ev.auto = false; ev.barrel = barrel; }
    } else if (st.current || code) {
      ev = { id: uid(), kind: 'result', code, barrel };
      session.events.push(ev);
    }
    // A ball in play goes on to how it was hit and where it ended up. The result is already saved.
    const inPlay = ab?.pitches.at(-1)?.call === 'inplay';
    ui.sheet = ev && inPlay ? { kind: 'batted', resultId: ev.id, contact: ev.contact || guessContact(code), spray: ev.spray || null } : null;
    commit();
  };

  const actions = {
    mode: (d) => { ui.mode = d.v; try { localStorage.setItem('wgc.mode', d.v); } catch { /* preference only */ } render(); },
    print: () => window.print(),
    type: (d) => { ui.pitchType = Number(d.code); render(); },
    call: (d) => logPitch(d.call, ensureStateFor(session)),
    undo: () => { session.events = undo(session.events); resetEntry(); commit(); },
    'open-result': () => { ui.sheet = { kind: 'result' }; render(); },
    'toggle-barrel': (d, el) => {
      // No redraw, so a result already being typed isn't lost.
      ui.sheet.barrel = !ui.sheet.barrel;
      el.classList.toggle('on', ui.sheet.barrel);
      el.setAttribute('aria-pressed', String(ui.sheet.barrel));
    },
    'result-chip': (d) => saveResult(d.code),
    'result-save': () => saveResult(root.querySelector('#result-code').value.trim().toUpperCase()),
    'sheet-cancel': () => { ui.sheet = null; render(); },
    'set-contact': (d) => { ui.sheet.contact = ui.sheet.contact === d.v ? '' : d.v; render(); },
    'batted-save': () => {
      const ev = session.events.find((e) => e.id === ui.sheet.resultId);
      if (ev) { ev.contact = ui.sheet.contact || ''; ev.spray = ui.sheet.spray || null; }
      ui.sheet = null;
      commit();
    },
    'end-inning': () => { if (confirm('End this inning now?')) { session.events.push({ id: uid(), kind: 'endInning' }); commit(); } },
    'no-result': () => { session.events.push({ id: uid(), kind: 'result', code: '' }); commit(); },
    'open-pitcher': () => { ui.sheet = { kind: 'pitcher' }; render(); },
    'open-sub': () => { const { state } = ensureStateFor(session); ui.sheet = { kind: 'sub', slot: state.slot, size: state.size }; render(); },
    'toggle-log': () => { ui.showLog = !ui.showLog; render(); },
    'edit-cancel': () => { resetEntry(); render(); },
    'edit-event': (d) => {
      const ev = session.events.find((e) => e.id === d.id);
      if (ev.kind === 'result') { ui.sheet = { kind: 'result', editId: ev.id, barrel: Boolean(ev.barrel) }; render(); return; }
      ui.editing = ev.id;
      ui.pitchType = ev.pitchType;
      ui.loc = ev.x == null ? null : { x: ev.x, y: ev.y };
      render();
      window.scrollTo(0, 0);
    },
    'delete-event': (d) => {
      const ev = session.events.find((e) => e.id === d.id);
      const msg = ev.kind === 'result'
        ? 'Delete this result? The next batter\'s pitches will join this at-bat.'
        : 'Delete this entry?';
      if (!confirm(msg)) return;
      session.events = session.events.filter((e) => e.id !== d.id);
      commit();
    },
    'set-hand': (d) => setBatterField('hand', d.v),
  };
  // Applies to whoever is in the spot now, which may be a substitute.
  const setBatterValue = (field, v) => {
    const { slot } = ensureStateFor(session).state;
    const sub = session.events.findLast((e) => e.kind === 'sub' && e.slot === slot);
    if (sub) sub[field] = v;
    else session.lineup[slot] = { ...(session.lineup[slot] || {}), [field]: v };
  };
  const setBatterField = (field, v) => {
    const { state } = ensureStateFor(session);
    setBatterValue(field, state.lineup[state.slot]?.[field] === v ? '' : v);
    commit();
  };

  screen = {
    render,
    actions,
    // The server had a newer copy of this chart, so show that one.
    onSync() {
      const latest = store.getLocal(id);
      if (latest && latest !== session) { session = latest; render(); }
    },
  };
  // Slow answers from the Sheet must not redraw over someone typing or choosing a result.
  const redrawQuietly = () => {
    const tag = document.activeElement?.tagName;
    if (ui.sheet || tag === 'INPUT' || tag === 'TEXTAREA') redrawChart();
    else render();
  };
  const updateDayTotals = async () => {
    const prior = await store.dayPriorPitches(session);
    if (screen.render !== render || !prior) return;
    const sorted = (o) => JSON.stringify(Object.entries(o || {}).sort());
    if (sorted(prior) === sorted(session.priorPitches)) return;
    session.priorPitches = prior;
    store.save(session);
    redrawQuietly();
  };
  const shown = Boolean(session);
  store.loadSession(id).then((s) => {
    if (screen.render !== render) return;
    if (!s) { root.innerHTML = h`${topbar('Chart')}<main class="page"><p class="error">This chart isn't on this device and the Google Sheet can't be reached.</p></main>`; return; }
    const changed = s !== session;
    session = s;
    if (!shown) render();
    else if (changed) redrawQuietly();
    updateDayTotals();
  });
  if (session) render();
}

root.addEventListener('click', (e) => {
  if (e.target.dataset?.act === 'sheet-cancel-bg') { screen.actions?.['sheet-cancel'](); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = screen.actions?.[el.dataset.act];
  if (fn) fn(el.dataset, el);
});

// ---------- Stats ----------
function statsScreen() {
  const filter = { from: '', to: '', type: '' };
  let result = null;
  let error = '';
  let rows = [];
  const load = async () => {
    try {
      rows = filterRows(await store.allRows(), filter);
      result = stats(rows);
      error = '';
    } catch { error = 'Stats need a connection to the Google Sheet.'; }
    render();
  };
  const render = () => {
    root.innerHTML = h`${topbar('Stats')}<main class="page">
      <form class="card form-grid" id="filter">
        <label>From<input type="date" name="from" value="${filter.from}"></label>
        <label>To<input type="date" name="to" value="${filter.to}"></label>
        <label>Type<select name="type"><option value="">All</option>${Object.entries(TYPES).map(([k, v]) => h`<option value="${k}" ${filter.type === k ? safe('selected') : ''}>${v}</option>`)}</select></label>
      </form>
      ${error && h`<p class="error">${error}</p>`}
      <div class="row" style="margin-bottom:.8rem">
        <button type="button" class="primary" id="csv" ${rows.length ? '' : safe('disabled')}>Download CSV</button>
        <span class="muted">One row per pitch. Filter on final_pitch_of_at_bat = 1 for one row per at-bat.</span>
      </div>
      ${result && h`<section class="card"><h2>Pitchers</h2><div class="tablewrap"><table>
        <tr><th>Name</th><th>IP</th><th>BF</th><th>Pitches</th><th>Strike%</th><th>1st-pitch strike%</th><th>Whiff%</th><th>H</th><th>BB</th><th>K</th><th>Barrels</th></tr>
        ${result.pitchers.map((p) => h`<tr><td><a href="#/player/${encodeURIComponent(p.name)}">${p.name}</a></td><td>${ip(p.outs)}</td><td>${p.pa}</td><td>${p.pitches}</td>
          <td>${pct(p.strikes, p.pitches)}</td><td>${pct(p.first_strikes, p.first_pitches)}</td><td>${pct(p.whiffs, p.swings)}</td><td>${p.h}</td><td>${p.bb}</td><td>${p.k}</td><td>${p.barrels}</td></tr>`)}
      </table></div></section>
      <section class="card"><h2>Hitters</h2><div class="tablewrap"><table>
        <tr><th>Name</th><th>PA</th><th>AB</th><th>H</th><th>BB</th><th>K</th><th>AVG</th><th>OBP</th><th>Pitches seen</th><th>Barrels</th></tr>
        ${result.batters.map((b) => h`<tr><td><a href="#/player/${encodeURIComponent(b.name)}">${b.name}</a></td><td>${b.pa}</td><td>${b.ab}</td><td>${b.h}</td><td>${b.bb}</td><td>${b.k}</td>
          <td>${avg(b.h, b.ab)}</td><td>${avg(b.h + b.bb + b.hbp, b.pa)}</td><td>${b.pitches_seen}</td><td>${b.barrels}</td></tr>`)}
      </table></div></section>`}
    </main>`;
    root.querySelector('#filter').addEventListener('change', (e) => { filter[e.target.name] = e.target.value; load(); });
    root.querySelector('#csv').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: 'wabash-pitches.csv' });
      link.click();
      URL.revokeObjectURL(url);
    });
  };
  screen = { render() {} };
  render();
  load();
}

async function playerScreen(name) {
  screen = { render() {} };
  root.innerHTML = h`${topbar(name)}<main class="page"><p class="muted">Loading…</p></main>`;
  let d;
  try { d = playerHistory(await store.allRows(), name); }
  catch { root.innerHTML = h`${topbar(name)}<main class="page"><p class="error">Player history needs a connection to the Google Sheet.</p></main>`; return; }
  const codes = PITCH_CODES;
  const label = (c) => codes.find((x) => x.code === c)?.label || `Type ${c}`;
  root.innerHTML = h`${topbar(name)}<main class="page">
    ${d.asPitcher.length > 0 && h`<section class="card"><h2>Pitching by session</h2><div class="tablewrap"><table>
      <tr><th>Date</th><th class="left">Opponent</th><th class="left">Type</th><th>Pitches</th><th>Strike%</th><th>BF</th><th>H</th><th>BB</th><th>K</th></tr>
      ${d.asPitcher.map((g) => h`<tr><td><a href="#/session/${g.session_id}">${g.date}</a></td><td class="left">${g.opponent}</td><td class="left">${TYPES[g.type] || g.type}</td><td>${g.pitches}</td><td>${pct(g.strikes, g.pitches)}</td><td>${g.bf}</td><td>${g.h}</td><td>${g.bb}</td><td>${g.k}</td></tr>`)}
    </table></div></section>
    <section class="card"><h2>By pitch type</h2><div class="tablewrap"><table>
      <tr><th>Pitch</th><th>Thrown</th><th>Strike%</th><th>Whiff%</th></tr>
      ${d.byType.map((t) => h`<tr><td>${label(t.pitch_type)}</td><td>${t.pitches}</td><td>${pct(t.strikes, t.pitches)}</td><td>${pct(t.whiffs, t.swings)}</td></tr>`)}
    </table></div></section>`}
    ${d.asBatter.length > 0 && h`<section class="card"><h2>At-bats</h2><div class="tablewrap"><table>
      <tr><th>Date</th><th class="left">Opponent</th><th class="left">Pitcher</th><th>Inn</th><th>Pitches</th><th>Result</th></tr>
      ${d.asBatter.map((a) => h`<tr><td><a href="#/session/${a.session_id}">${a.date}</a></td><td class="left">${a.opponent}</td><td class="left">${a.pitcher}</td><td>${a.inning}</td><td>${a.pitch_count}</td><td>${a.result || '–'}</td></tr>`)}
    </table></div></section>`}
    ${!d.asPitcher.length && !d.asBatter.length && h`<p class="muted">No charted data for ${name} yet.</p>`}
  </main>`;
}

// ---------- Roster and pitch codes ----------
async function rosterScreen() {
  screen = { render() {} };
  const render = () => {
    const { players } = store.getData();
    root.innerHTML = h`${topbar('Roster')}<main class="page">
      <form class="card" id="add-player"><h2>Add player</h2><div class="form-grid">
        <label>Name<input name="name" required autocomplete="off"></label>
        <label>Number<input name="number"></label>
        <label>Bats<select name="bats">${['', 'R', 'L', 'S'].map((o) => h`<option>${o}</option>`)}</select></label>
        <label>Throws<select name="throws">${['', 'R', 'L'].map((o) => h`<option>${o}</option>`)}</select></label>
      </div><button class="primary" style="margin-top:.6rem">Add</button></form>
      <section class="card"><h2>Players</h2><div class="tablewrap"><table>
        <tr><th>Name</th><th>#</th><th>Bats</th><th>Throws</th><th></th></tr>
        ${players.map((p) => h`<tr><td><a href="#/player/${encodeURIComponent(p.name)}">${p.name}</a></td><td>${p.number}</td><td>${p.bats}</td><td>${p.throws}</td>
          <td><button class="small danger" data-remove="${p.id}" aria-label="Remove ${p.name}">Remove</button></td></tr>`)}
      </table></div></section>
    </main>`;
    root.querySelector('#add-player').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await store.api('savePlayer', { player: Object.fromEntries(new FormData(e.target)) });
        await store.refreshData();
        render();
      } catch { alert('Changing the roster needs a connection to the Google Sheet.'); }
    });
    root.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await store.api('removePlayer', { id: Number(b.dataset.remove) });
        await store.refreshData();
        render();
      } catch { alert('Changing the roster needs a connection to the Google Sheet.'); }
    }));
  };
  await store.refreshData();
  render();
}

function loginScreen() {
  screen = { render() {} };
  root.innerHTML = h`${topbar('Sign in')}<main class="page"><form class="card" id="login">
    <label>Team passcode<input type="password" name="passcode" required autocomplete="current-password" autofocus></label>
    <p class="error" id="login-error" role="alert"></p>
    <button class="primary">Sign in</button></form></main>`;
  root.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const passcode = new FormData(e.target).get('passcode');
    const problem = await store.signIn(passcode);
    if (problem) {
      root.querySelector('#login-error').textContent = problem;
      return;
    }
    await store.refreshData();
    store.flush();
    location.hash = '#/';
  });
}

// ---------- Routing ----------
function route() {
  resetEntry();
  ui.sheet = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [page, arg] = parts;
  const param = arg ? decodeURIComponent(arg) : '';
  if (!page) homeScreen();
  else if (page === 'new') setupScreen();
  else if (page === 'edit') setupScreen(param);
  else if (page === 'session') chartScreen(param);
  else if (page === 'stats') statsScreen();
  else if (page === 'player') playerScreen(param);
  else if (page === 'roster') rosterScreen();
  else if (page === 'login') loginScreen();
  else homeScreen();
}

// Sync finishing must not redraw the screen, or it would wipe whatever is being typed.
store.onChange(() => {
  const slot = document.getElementById('sync-slot');
  if (slot) slot.innerHTML = syncBadge();
  screen.onSync?.();
});
window.addEventListener('hashchange', route);
store.refreshData().then(() => { store.flush(); });
route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
