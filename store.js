// Device storage and sync. Every change is written to the device first, then sent
// to the Google Sheet, so charting keeps working with no signal.
import { API_URL } from './config.js';
import { csvRows, priorPitches, replay } from './engine.js';

const PASSCODE_KEY = 'wgc.passcode';
const KEY = 'wgc.sessions.v1';
const DATA_KEY = 'wgc.data.v1';

const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};

const sessions = read(KEY, {});
const data = read(DATA_KEY, { players: [], summaries: [] });
let syncing = false;
let listener = () => {};

export const status = { state: 'idle', storageFull: false }; // idle | syncing | offline | signin

export const onChange = (fn) => { listener = fn; };
export const pending = () => Object.values(sessions).filter((s) => s.dirty).length;
export const getData = () => data;
export const getLocal = (id) => sessions[id];

function persist() {
  for (;;) {
    try {
      localStorage.setItem(KEY, JSON.stringify(sessions));
      status.storageFull = false;
      return;
    } catch {
      // Device storage full: drop the oldest copies the server already has.
      const synced = Object.values(sessions).filter((s) => !s.dirty).sort((a, b) => a.updatedAt - b.updatedAt);
      if (!synced.length) {
        status.storageFull = true;
        return;
      }
      delete sessions[synced[0].id];
    }
  }
}
const persistData = () => { try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch { /* cache only */ } };

const getPasscode = () => {
  try { return localStorage.getItem(PASSCODE_KEY) || ''; } catch { return ''; }
};

// Sent as text/plain because Apps Script can't answer the check browsers make for JSON requests.
async function post(action, payload, passcode) {
  const res = await fetch(API_URL || 'api', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, passcode, ...payload }),
  });
  if (!res.ok) throw new Error('Request failed');
  return res.json();
}

export async function api(action, payload = {}) {
  const passcode = getPasscode();
  const out = passcode ? await post(action, payload, passcode) : { error: 'signin' };
  if (out.error === 'signin') {
    status.state = 'signin';
    listener();
    throw Object.assign(new Error('Sign in required'), { status: 401 });
  }
  if (out.error) throw new Error(out.error);
  return out;
}

// Returns an error message, or null when the passcode works.
export async function signIn(passcode) {
  const MESSAGES = { signin: 'Wrong passcode', locked: 'Too many attempts. Wait a minute.', not_configured: 'The Google Sheet script needs its passcode set.' };
  try {
    const out = await post('ping', {}, passcode);
    if (out.error) return MESSAGES[out.error] || 'Something went wrong. Try again.';
  } catch {
    return 'No connection.';
  }
  try { localStorage.setItem(PASSCODE_KEY, passcode); } catch { return 'This browser is blocking saved data.'; }
  status.state = 'idle';
  return null;
}

export function save(session) {
  session.updatedAt = Date.now();
  session.dirty = true;
  sessions[session.id] = session;
  persist();
  listener();
  flush();
}

export async function flush() {
  if (syncing) return;
  syncing = true;
  try {
    for (const s of Object.values(sessions).filter((x) => x.dirty)) {
      const sentAt = s.updatedAt;
      const { dirty, ...payload } = s;
      status.state = 'syncing';
      const summary = {
        pitchers: replay(payload).state.pitchers.join(', '),
        pitch_count: payload.events.filter((e) => e.kind === 'pitch').length,
      };
      const { saved } = await api('save', { session: payload, rows: csvRows(payload), summary });
      if (saved && sessions[s.id]?.updatedAt === sentAt) sessions[s.id].dirty = false;
      if (!saved) {
        // The server has a newer copy and kept this one on file, so take the newer one.
        sessions[s.id] = { ...(await api('get', { id: s.id })).session, dirty: false };
      }
      persist();
    }
    status.state = getPasscode() ? 'idle' : 'signin';
  } catch (err) {
    status.state = err.status === 401 ? 'signin' : 'offline';
  } finally {
    syncing = false;
    listener();
    // A pitch logged while that request was running still needs sending.
    if (status.state === 'idle' && pending()) flush();
  }
}

export async function loadSession(id) {
  const local = sessions[id];
  if (local?.dirty) return local;
  try {
    const { session: remote } = await api('get', { id });
    // An identical copy is left alone, so a chart open on screen isn't swapped out from under it.
    if (remote && (!local || remote.updatedAt > local.updatedAt)) {
      sessions[id] = { ...remote, dirty: false };
      persist();
    }
  } catch { /* fall back to the device copy */ }
  return sessions[id];
}

// Server list plus anything still waiting on this device.
export async function listSessions() {
  try {
    data.summaries = (await api('list')).sessions;
    persistData();
  } catch { /* use the cached list */ }
  const byId = new Map(data.summaries.map((s) => [s.id, s]));
  for (const s of Object.values(sessions)) {
    if (s.dirty && s.deleted) byId.delete(s.id);
    else if (s.dirty) {
      byId.set(s.id, {
        id: s.id, date: s.date, opponent: s.opponent, type: s.type,
        pitchers: s.pitcher, pitch_count: s.events.filter((e) => e.kind === 'pitch').length,
        updatedAt: s.updatedAt,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt);
}

// Returns null if another chart from that day can't be reached, so a known total isn't lowered.
export async function dayPriorPitches(session) {
  const list = await listSessions();
  const sameDay = list.filter((s) => s.id !== session.id && s.date === session.date);
  const others = await Promise.all(sameDay.map((s) => loadSession(s.id)));
  return others.every(Boolean) ? priorPitches(session, others) : null;
}

// Returns false if the chart can't be reached to mark it deleted.
export async function deleteSession(id) {
  const session = await loadSession(id);
  if (!session) return false;
  session.deleted = true;
  data.summaries = data.summaries.filter((s) => s.id !== id);
  persistData();
  save(session);
  return true;
}

export async function refreshData() {
  try {
    data.players = (await api('players')).players;
    persistData();
  } catch { /* use the cached copy */ }
  return data;
}

export const allRows = async () => (await api('rows')).rows;

window.addEventListener('online', flush);
setInterval(() => { if (pending()) flush(); }, 15000);
