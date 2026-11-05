// Stats and the CSV file, worked out in the browser from the rows on the Pitches tab.

export function filterRows(rows, { from, to, type } = {}) {
  return rows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to) && (!type || r.session_type === type));
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (typeof v === 'number') return String(v);
    let s = String(v ?? '');
    // Stop a player name like "=cmd()" from running as a formula in Excel.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')}\r\n`;
}

export function stats(rows) {
  const pitchers = new Map();
  const batters = new Map();
  const entry = (map, name, make) => {
    if (!map.has(name)) map.set(name, make());
    return map.get(name);
  };
  const newPitcher = (name) => () => ({ name, pitches: 0, strikes: 0, whiffs: 0, swings: 0, first_pitches: 0, first_strikes: 0, pa: 0, h: 0, bb: 0, k: 0, outs: 0, barrels: 0 });
  const newBatter = (name) => () => ({ name, pa: 0, ab: 0, h: 0, bb: 0, k: 0, hbp: 0, pitches_seen: 0, barrels: 0 });
  for (const r of rows) {
    if (r.pitcher) {
      const p = entry(pitchers, r.pitcher, newPitcher(r.pitcher));
      if (r.pitch_number !== '') {
        p.pitches += 1;
        p.strikes += r.is_strike;
        p.whiffs += r.is_whiff;
        // Rows saved before barrels existed have nothing in this column.
        p.barrels += r.is_barrel ? 1 : 0;
        p.swings += r.is_swing;
        if (r.balls_before === 0 && r.strikes_before === 0) {
          p.first_pitches += 1;
          p.first_strikes += r.is_strike;
        }
      }
      if (r.final_pitch_of_at_bat && r.at_bat_result) {
        p.pa += 1;
        p.h += r.is_hit;
        p.bb += r.is_walk;
        p.k += r.is_strikeout;
        p.outs += r.at_bat_outs;
      }
    }
    if (r.batter) {
      const b = entry(batters, r.batter, newBatter(r.batter));
      if (r.pitch_number !== '') b.pitches_seen += 1;
      b.barrels += r.is_barrel ? 1 : 0;
      if (r.final_pitch_of_at_bat && r.at_bat_result) {
        b.pa += 1;
        b.ab += r.is_ab;
        b.h += r.is_hit;
        b.bb += r.is_walk;
        b.k += r.is_strikeout;
        b.hbp += r.is_hbp;
      }
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { pitchers: [...pitchers.values()].sort(byName), batters: [...batters.values()].sort(byName) };
}

export function playerHistory(rows, name) {
  const newest = (a, b) => b.date.localeCompare(a.date);
  const sessions = new Map();
  const byType = new Map();
  const asBatter = [];
  for (const r of rows) {
    if (r.pitcher === name) {
      if (!sessions.has(r.session_id)) {
        sessions.set(r.session_id, { session_id: r.session_id, date: r.date, opponent: r.opponent, type: r.session_type, pitches: 0, strikes: 0, whiffs: 0, bf: 0, h: 0, bb: 0, k: 0 });
      }
      const g = sessions.get(r.session_id);
      if (r.pitch_number !== '') {
        g.pitches += 1;
        g.strikes += r.is_strike;
        g.whiffs += r.is_whiff;
        if (!byType.has(r.pitch_code)) byType.set(r.pitch_code, { pitch_type: r.pitch_code, pitches: 0, strikes: 0, whiffs: 0, swings: 0 });
        const t = byType.get(r.pitch_code);
        t.pitches += 1;
        t.strikes += r.is_strike;
        t.whiffs += r.is_whiff;
        t.swings += r.is_swing;
      }
      if (r.final_pitch_of_at_bat && r.at_bat_result) {
        g.bf += 1;
        g.h += r.is_hit;
        g.bb += r.is_walk;
        g.k += r.is_strikeout;
      }
    }
    if (r.batter === name && r.final_pitch_of_at_bat) {
      asBatter.push({ session_id: r.session_id, date: r.date, opponent: r.opponent, type: r.session_type, pitcher: r.pitcher, inning: r.inning, result: r.at_bat_result, pitch_count: r.at_bat_pitches });
    }
  }
  return {
    name,
    asPitcher: [...sessions.values()].sort(newest),
    byType: [...byType.values()].sort((a, b) => b.pitches - a.pitches),
    asBatter: asBatter.sort(newest),
  };
}
