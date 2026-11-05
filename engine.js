// Game logic shared by the browser and the server.
// A session is an ordered event log; everything else (count, outs, the chart, the
// CSV, the stats) is derived by replaying it, so editing a past event is safe.
// Only the at-bat itself is tracked: base runners are not charted.
//
// Event kinds:
//   pitch   { pitchType, call, x, y }   call: ball|called|swinging|foul|inplay|hbp
//   result  { code, barrel?, contact?, spray?, auto?, byPitch? }   ends the at-bat; code '' = no result recorded
//           contact: GB|LD|FB. spray: { x, y } in feet from home plate, where the ball ended up.
//   pitcher { name }
//   sub     { slot, name, number, hand }
//   endInning {}

export const PITCH_CODES = [
  { code: 1, label: 'Fastball' }, { code: 2, label: 'Curve' }, { code: 3, label: 'Slider' },
  { code: 4, label: 'Change' }, { code: 5, label: 'Cutter' },
];

export const CALLS = {
  ball: 'Ball', called: 'Called strike', swinging: 'Whiff',
  foul: 'Foul', inplay: 'In play', hbp: 'Hit by pitch',
};

export const CONTACT_TYPES = [['GB', 'Ground ball'], ['LD', 'Line drive'], ['FB', 'Fly ball']];

export const MAX_LINEUP = 15;
// Charts saved before lineup sizes existed have no size and are 9 batters.
export const lineupSize = (session) => Math.min(MAX_LINEUP, Math.max(1, Number(session.lineupSize) || 9));

export const isBallRow = (call) => call === 'ball' || call === 'hbp';
export const isSwing = (call) => call === 'swinging' || call === 'foul' || call === 'inplay';

// What a result code means for the batter. `reached` is the base the batter got to.
export function classify(rawCode) {
  const c = (rawCode || '').trim().toUpperCase();
  const base = { reached: 0, outs: 0, isHit: false, isAB: true, isBB: false, isK: false, isHBP: false };
  if (!c) return { ...base, isAB: false };
  if (c === 'BB' || c === 'IBB') return { ...base, reached: 1, isAB: false, isBB: true };
  if (c === 'HBP') return { ...base, reached: 1, isAB: false, isHBP: true };
  if (/^K.*(WP|PB)/.test(c)) return { ...base, reached: 1, isK: true };
  if (/^K/.test(c)) return { ...base, outs: 1, isK: true };
  const hit = c.match(/^([123])B|^HR/);
  if (hit) return { ...base, reached: hit[1] ? Number(hit[1]) : 4, isHit: true };
  if (/^E/.test(c)) return { ...base, reached: 1 };
  if (/^FC/.test(c)) return { ...base, reached: 1, outs: 1 };
  if (/^(SF|SAC)/.test(c)) return { ...base, outs: 1, isAB: false };
  if (/TP/.test(c)) return { ...base, outs: 3 };
  if (/DP/.test(c)) return { ...base, outs: 2 };
  return { ...base, outs: 1 }; // F9, 6-3, L6, P4, 3U, ...
}

const emptyAtBat = (state, seq) => {
  const p = state.lineup[state.slot] || {};
  return {
    seq, slot: state.slot, col: state.appearances[state.slot], inning: state.inning, pitcher: state.pitcher,
    batter: p.name || '', number: p.number || '', hand: p.hand || '',
    pitches: [], result: null, resultId: null, rule: null, outNumber: null, balls: 0, strikes: 0,
    barrel: false, contact: '', spray: null, pitcherTotal: 0, newPitcher: '', newBatter: '',
  };
};

export function replay(session) {
  const size = lineupSize(session);
  const state = {
    size, inning: 1, outs: 0, slot: 0, balls: 0, strikes: 0,
    pitcher: session.pitcher || '',
    pitchers: session.pitcher ? [session.pitcher] : [],
    lineup: (session.lineup || []).map((p) => ({ ...p })),
    appearances: Array(size).fill(0),
    subs: Array.from({ length: size }, () => []),
  };
  while (state.lineup.length < size) state.lineup.push({});
  const atBats = [];
  const pitcherTotals = new Map(Object.entries(session.priorPitches || {}));
  const newHitters = new Map(); // Lineup spot -> sub who hasn't batted yet.
  let cur = null;

  const open = () => {
    if (!cur) {
      cur = emptyAtBat(state, atBats.length);
      // Flags the first cell for a new pitcher or pinch hitter, so the chart shows when they came in.
      const previousPitcher = atBats.length ? atBats[atBats.length - 1].pitcher : session.pitcher || '';
      if (cur.pitcher !== previousPitcher) cur.newPitcher = cur.pitcher;
      if (newHitters.has(cur.slot)) {
        cur.newBatter = newHitters.get(cur.slot);
        newHitters.delete(cur.slot);
      }
      atBats.push(cur);
    }
    return cur;
  };
  const closeBatter = (advanceSlot) => {
    if (cur) state.appearances[cur.slot] += 1;
    cur = null;
    state.balls = 0;
    state.strikes = 0;
    if (advanceSlot) state.slot = (state.slot + 1) % size;
  };
  const endInning = () => {
    state.inning += 1;
    state.outs = 0;
    // A batter whose at-bat was cut off by the inning ending leads off the next one.
    if (cur) closeBatter(false);
  };

  for (const ev of session.events || []) {
    if (ev.kind === 'pitch') {
      const ab = open();
      ab.pitcherTotal = (pitcherTotals.get(ab.pitcher) || 0) + 1;
      pitcherTotals.set(ab.pitcher, ab.pitcherTotal);
      ab.pitches.push({ ...ev, n: ab.pitches.length + 1, ballsBefore: state.balls, strikesBefore: state.strikes, pitcherTotal: ab.pitcherTotal });
      if (ev.call === 'ball') state.balls += 1;
      else if (ev.call === 'called' || ev.call === 'swinging' || ev.call === 'inplay') state.strikes += 1;
      else if (ev.call === 'foul' && state.strikes < 2) state.strikes += 1;
      ab.balls = state.balls;
      ab.strikes = Math.min(state.strikes, 3);
    } else if (ev.kind === 'result') {
      const ab = open();
      ab.result = ev.code || '';
      ab.resultId = ev.id;
      ab.rule = classify(ev.code);
      // Only a ball in play has a barrel, contact type or spot, even if that pitch was later edited to something else.
      const inPlay = ab.pitches.at(-1)?.call === 'inplay';
      ab.barrel = Boolean(ev.barrel) && inPlay;
      ab.contact = inPlay ? ev.contact || '' : '';
      ab.spray = inPlay && ev.spray ? ev.spray : null;
      state.outs = Math.min(state.outs + ab.rule.outs, 3);
      if (ab.rule.outs) ab.outNumber = state.outs;
      closeBatter(true);
      if (state.outs >= 3) endInning();
    } else if (ev.kind === 'pitcher') {
      state.pitcher = ev.name;
      if (!state.pitchers.includes(ev.name)) state.pitchers.push(ev.name);
      if (cur && !cur.pitches.length) cur.pitcher = ev.name;
    } else if (ev.kind === 'sub') {
      const { slot, name, number, hand } = ev;
      if (slot >= size) continue;
      state.subs[slot].push(name);
      newHitters.set(slot, name);
      state.lineup[slot] = { name, number, hand };
      if (cur && cur.slot === slot && !cur.pitches.length) Object.assign(cur, { batter: name, number, hand });
    } else if (ev.kind === 'endInning') {
      endInning();
    }
  }

  return { atBats, state, warnings: findWarnings(atBats), current: cur };
}

function findWarnings(atBats) {
  const out = [];
  for (const ab of atBats) {
    if (ab.result === 'BB' && ab.balls !== 4 && ab.pitches.length) out.push({ ab, text: `${ab.batter || 'Batter'}: result is BB but the count shows ${ab.balls} balls` });
    if (/^K/.test(ab.result || '') && ab.strikes !== 3 && ab.pitches.length) out.push({ ab, text: `${ab.batter || 'Batter'}: result is ${ab.result} but the count shows ${ab.strikes} strikes` });
  }
  return out;
}

// What each pitcher already threw that day, from charts with the same date started before this one.
export function priorPitches(session, others) {
  const started = (s) => s.createdAt ?? s.updatedAt ?? 0;
  const isEarlier = (o) => started(o) < started(session) || (started(o) === started(session) && o.id < session.id);
  const totals = new Map();
  for (const other of others) {
    if (other.id === session.id || other.deleted || other.date !== session.date || !isEarlier(other)) continue;
    for (const ab of replay(other).atBats) {
      if (ab.pitcher && ab.pitches.length) totals.set(ab.pitcher, (totals.get(ab.pitcher) || 0) + ab.pitches.length);
    }
  }
  return Object.fromEntries(totals);
}

// The result an at-bat ends with automatically once this pitch is added, if any.
export function autoResult(state, call) {
  if (call === 'hbp') return 'HBP';
  if (call === 'ball' && state.balls === 3) return 'BB';
  if (call === 'called' && state.strikes === 2) return 'KL';
  if (call === 'swinging' && state.strikes === 2) return 'K';
  return null;
}

// Removes the last event, along with the pitch that auto-created it.
export function undo(events) {
  const next = [...events];
  const last = next.pop();
  if (last?.kind === 'result' && last.auto) next.pop();
  return next;
}

// A best guess from the scoring code, so the usual case is one tap. Hits say nothing, so they get none.
export function guessContact(rawCode) {
  const c = (rawCode || '').trim().toUpperCase();
  if (/^(F|P)\d|^SF/.test(c)) return 'FB';
  if (/^L\d/.test(c)) return 'LD';
  if (/^\d-\d|^\dU|^G/.test(c)) return 'GB';
  return '';
}

// Which fielder's area a spot is in. x is feet toward the first-base side, y feet toward center field.
export function sprayZone(x, y) {
  if (x == null || y == null) return '';
  const angle = (Math.atan2(x, y) * 180) / Math.PI; // 0 is straight at second base.
  if (y <= 0 || Math.abs(angle) > 45) return 'Foul';
  const distance = Math.hypot(x, y);
  if (distance < 30) return 'C';
  if (distance < 150) {
    if (distance < 80 && Math.abs(angle) < 12) return 'P';
    return angle < -25 ? '3B' : angle < 0 ? 'SS' : angle < 25 ? '2B' : '1B';
  }
  return angle < -15 ? 'LF' : angle <= 15 ? 'CF' : 'RF';
}

export const isStrike = (call) => call !== 'ball' && call !== 'hbp';
export const inZone = (x, y) => x != null && y != null && x >= 0 && x <= 1 && y >= 0 && y <= 1;

const OUTCOME_NAMES = { ball: 'ball', called: 'called_strike', swinging: 'whiff', foul: 'foul', inplay: 'in_play', hbp: 'hit_by_pitch' };
const pitchName = (code) => PITCH_CODES.find((c) => c.code === code)?.label || '';

// Filled in only on the pitch that was put in play.
const battedBall = (ab) => ({
  batted_ball: ab.contact || '', spray_x: ab.spray?.x ?? '', spray_y: ab.spray?.y ?? '',
  spray_zone: ab.spray ? sprayZone(ab.spray.x, ab.spray.y) : '',
});

// One CSV row per pitch. The at-bat's result is on every row, and final_pitch_of_at_bat = 1
// picks out exactly one row per at-bat, so one file answers both pitch and at-bat questions.
export function csvRows(session) {
  const rows = [];
  replay(session).atBats.forEach((ab, i) => {
    const rule = ab.rule || classify('');
    const shared = {
      date: session.date, session_id: session.id, opponent: session.opponent || '', session_type: session.type || '',
      inning: ab.inning, pitcher: ab.pitcher, batter: ab.batter, batter_number: ab.number, batter_side: ab.hand,
      lineup_spot: ab.slot + 1, batter_trip: ab.col + 1, at_bat_id: `${session.id}:${i + 1}`,
    };
    const atBat = {
      at_bat_result: ab.result ?? '', at_bat_pitches: ab.pitches.length, at_bat_outs: rule.outs,
      is_ab: ab.result && rule.isAB ? 1 : 0, is_hit: rule.isHit ? 1 : 0, is_walk: rule.isBB ? 1 : 0,
      is_strikeout: rule.isK ? 1 : 0, is_hbp: rule.isHBP ? 1 : 0,
    };
    ab.pitches.forEach((p) => {
      rows.push({
        ...shared, pitch_number: p.n, balls_before: p.ballsBefore, strikes_before: p.strikesBefore,
        pitch_code: p.pitchType, pitch_name: pitchName(p.pitchType), outcome: OUTCOME_NAMES[p.call] || p.call,
        location_x: p.x ?? '', location_y: p.y ?? '', in_zone: p.x == null ? '' : inZone(p.x, p.y) ? 1 : 0,
        is_strike: isStrike(p.call) ? 1 : 0, is_swing: isSwing(p.call) ? 1 : 0, is_whiff: p.call === 'swinging' ? 1 : 0,
        final_pitch_of_at_bat: p.n === ab.pitches.length ? 1 : 0, ...atBat,
        is_barrel: ab.barrel && p.n === ab.pitches.length ? 1 : 0, pitcher_pitch_total: p.pitcherTotal,
        ...(p.n === ab.pitches.length ? battedBall(ab) : battedBall({})),
      });
    });
    // A result with no pitches thrown, such as an intentional walk, still needs its row.
    if (!ab.pitches.length && ab.result) {
      rows.push({
        ...shared, pitch_number: '', balls_before: '', strikes_before: '', pitch_code: '', pitch_name: '', outcome: '',
        location_x: '', location_y: '', in_zone: '', is_strike: 0, is_swing: 0, is_whiff: 0,
        final_pitch_of_at_bat: 1, ...atBat, is_barrel: 0, pitcher_pitch_total: '', ...battedBall({}),
      });
    }
  });
  return rows;
}
