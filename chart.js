// Draws the Wabash College Pitching Chart as an SVG page, matching the paper layout.
import { isBallRow } from './engine.js';

const RED = '#a6192e';
const BLUE = '#1558c0';
const HITTER_RED = '#d0021b';
const PAGE = { w: 850, h: 1100 };
const LEFT = 30;
const LINEUP_W = 100;
const CELL_W = 138;
const FULL_ROW_H = 96;
const ROWS_TOP = 134;
const ROWS_AREA = FULL_ROW_H * 9; // Lineups over 9 share this space so the chart stays on one page.
const COLS = 5;
const SIDE_W = 26;
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const line = (x1, y1, x2, y2, w = 0.8) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#222" stroke-width="${w}"/>`;
const rect = (x, y, w, h, sw = 0.8, fill = 'none') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#222" stroke-width="${sw}"/>`;
const text = (x, y, s, attrs = '') => `<text x="${x}" y="${y}" ${attrs}>${esc(s)}</text>`;

// Every vertical measurement scales with the row height.
function geometry(rows) {
  const rowH = rows > 9 ? ROWS_AREA / rows : FULL_ROW_H;
  const k = rowH / FULL_ROW_H;
  const sqH = 17.5 * k;
  return {
    k, rowH, sqH, upperH: rowH - sqH * 2,
    zone: { x: 16, y: 17 * k, size: 24 * k },
    markFont: Math.max(8, 10 * k), numberFont: Math.max(7.5, 9 * k),
  };
}

function blankCell(x, y, g, n = 8) {
  const mainW = CELL_W - SIDE_W;
  const sqW = mainW / n;
  let s = '';
  s += rect(x + g.zone.x, y + g.zone.y, g.zone.size, g.zone.size);
  s += line(x + mainW / 2, y, x + mainW / 2, y + g.upperH);
  s += line(x + mainW, y, x + mainW, y + g.rowH);
  s += line(x + mainW, y + 20 * g.k, x + CELL_W, y + 20 * g.k);
  s += line(x, y + g.upperH, x + CELL_W, y + g.upperH);
  s += line(x, y + g.upperH + g.sqH, x + mainW, y + g.upperH + g.sqH);
  for (let i = 1; i < n; i += 1) s += line(x + i * sqW, y + g.upperH, x + i * sqW, y + g.rowH);
  return s;
}

function zoneNumbers(ab, x, y, g) {
  const clampX = (v) => Math.max(x + 4, Math.min(x + 52, v));
  // A new pitcher's name sits along the top of this area, so numbers stay below it.
  const top = ab.newPitcher ? Math.max(g.numberFont, g.zone.y) : g.numberFont;
  const clampY = (v) => Math.max(y + top, Math.min(y + g.upperH - 2, v));
  const placed = [];
  let s = '';
  for (const p of ab.pitches) {
    if (p.x == null || p.y == null) continue;
    const cx = clampX(x + g.zone.x + p.x * g.zone.size);
    const cy = clampY(y + g.zone.y + p.y * g.zone.size + 3);
    // Nudge overlapping numbers apart so they stay readable.
    let px = cx;
    let py = cy;
    for (let t = 1; t < 16 && placed.some(([a, b]) => Math.hypot(a - px, b - py) < 7); t += 1) {
      const angle = t * 2.4;
      px = clampX(cx + Math.cos(angle) * t * 1.6);
      py = clampY(cy + Math.sin(angle) * t * 1.6);
    }
    placed.push([px, py]);
    s += text(px.toFixed(1), py.toFixed(1), p.n, `font-size="${g.numberFont}" font-weight="600" text-anchor="middle"`);
  }
  return s;
}

// Circle = foul or ball in play. Triangle = whiff. Plain digit = taken pitch.
function pitchMark(call, cx, cy, sqW, g) {
  const r = Math.min(sqW / 2 - 0.5, g.sqH / 2 - 1.5);
  if (call === 'foul' || call === 'inplay') {
    return `<circle class="mark-contact" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#111" stroke-width="1"/>`;
  }
  if (call === 'swinging') {
    const top = cy - g.sqH / 2 + 0.8;
    const bottom = cy + g.sqH / 2 - 0.8;
    return `<polygon class="mark-whiff" points="${cx},${top} ${cx + r + 0.5},${bottom} ${cx - r - 0.5},${bottom}" fill="none" stroke="#111" stroke-width="1"/>`;
  }
  return '';
}

function gridMarks(ab, x, y, sqW, g) {
  let s = '';
  ab.pitches.forEach((p, i) => {
    const cx = x + (i + 0.5) * sqW;
    const row = isBallRow(p.call) ? 0 : 1;
    const cy = y + g.upperH + row * g.sqH + g.sqH / 2;
    s += pitchMark(p.call, cx, cy, sqW, g);
    s += text(cx, cy + g.markFont * 0.35, p.pitchType, `font-size="${g.markFont}" font-weight="600" text-anchor="middle"`);
  });
  return s;
}

function resultText(code, x, y, g) {
  if (!code) return '';
  const cx = x + 84;
  const cy = y + g.upperH * 0.6;
  if (code === 'KL') return `<text transform="translate(${cx} ${cy}) scale(-1 1)" font-size="17" font-weight="600" text-anchor="middle">K</text>`;
  const size = code.length > 6 ? 10 : code.length > 4 ? 12 : 15;
  return text(cx, cy, code, `font-size="${size}" font-weight="600" text-anchor="middle"`);
}

// A hit with a spot on the field is drawn as a little spray chart in the result box, from home
// plate toward where it went: dashed = ground ball, straight = line drive, curved = fly ball.
// The hit type goes in the corner. Without a spot, the result is written out as usual.
const HIT_LABELS = { 1: '1B', 2: '2B', 3: '3B', 4: 'HR' };
const FENCE_FT = 330;
const INFIELD_FT = 150; // About the back edge of the infield dirt.
const INFIELD_SHARE = 0.35;
const MOUND_FT = 60.5;
const DIRT_RADIUS_FT = 95; // Infield dirt, measured from the mound.

// Feet from home to a share of the drawing. The infield is drawn small and the outfield gets most
// of the room, so it's easy to see an infield hit, a ball in front of the outfielders, or one hit deep.
function depth(ft) {
  if (ft <= INFIELD_FT) return (INFIELD_SHARE * ft) / INFIELD_FT;
  return Math.min(1, INFIELD_SHARE + ((1 - INFIELD_SHARE) * (ft - INFIELD_FT)) / (FENCE_FT - INFIELD_FT));
}

// How far from home, along a line at this angle, the edge of the infield dirt is.
function dirtEdge(deg) {
  const along = MOUND_FT * Math.cos((deg * Math.PI) / 180);
  return along + Math.sqrt(along * along - MOUND_FT * MOUND_FT + DIRT_RADIUS_FT * DIRT_RADIUS_FT);
}

function hitSpray(ab, x, y, g) {
  if (!ab.rule?.isHit || !ab.spray) return '';
  const mainW = CELL_W - SIDE_W;
  const homeX = x + mainW * 0.75;
  const homeY = y + g.upperH - 3;
  // Where an out number would go. Lower when a new hitter's name is along the top of the box.
  const labelFont = g.k < 0.8 ? 9 : 11;
  const labelY = y + (ab.newBatter ? 19 * g.k : 9 * Math.max(g.k, 0.8)) + labelFont * 0.35;
  // The drawing stays below the label, so short rows in a long lineup still read cleanly.
  const reach = Math.min(34, homeY - labelY - 2);
  const at = (deg, len) => [homeX + Math.sin((deg * Math.PI) / 180) * len, homeY - Math.cos((deg * Math.PI) / 180) * len];
  const pt = (deg, ft) => at(deg, depth(ft) * reach).map((v) => v.toFixed(1)).join(',');
  const arc = (feetAt) => Array.from({ length: 19 }, (_, i) => pt(-45 + i * 5, feetAt(-45 + i * 5))).join(' L');
  const faint = 'fill="none" stroke="#bbb" stroke-width="0.7"';
  // Foul lines and fence, the infield dirt, and the bases.
  let s = `<path class="spray-field" d="M${pt(-45, FENCE_FT)} L${homeX},${homeY} L${pt(45, FENCE_FT)} M${arc(() => FENCE_FT)} M${arc(dirtEdge)}" ${faint}/>`;
  s += `<path d="M${homeX},${homeY} L${pt(45, 90)} L${pt(0, 90 * Math.SQRT2)} L${pt(-45, 90)} Z" ${faint}/>`;

  // Keep the angle inside the foul lines and the length inside the box.
  const angle = Math.max(-44, Math.min(44, (Math.atan2(ab.spray.x, ab.spray.y) * 180) / Math.PI));
  const len = Math.max(0.08, depth(Math.hypot(ab.spray.x, ab.spray.y))) * reach;
  const [ex, ey] = at(angle, len);
  const end = `${ex.toFixed(1)},${ey.toFixed(1)}`;
  const stroke = 'fill="none" stroke="#111" stroke-width="1.5" stroke-linecap="round"';
  if (ab.contact === 'FB') {
    // Bows away from center field, so the curve stays inside the box.
    const side = angle < 0 ? -1 : 1;
    const [cx, cy] = at(angle + side * 28, len * 0.62);
    s += `<path class="spray spray-fly" d="M${homeX},${homeY} Q${cx.toFixed(1)},${cy.toFixed(1)} ${end}" ${stroke}/>`;
  } else if (ab.contact === 'GB') {
    s += `<path class="spray spray-ground" d="M${homeX},${homeY} L${end}" ${stroke} stroke-dasharray="3 2.2"/>`;
  } else {
    s += `<path class="spray spray-line" d="M${homeX},${homeY} L${end}" ${stroke}/>`;
  }
  s += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="1.8" fill="#111"/>`;
  s += text(x + mainW - 3, labelY, HIT_LABELS[ab.rule.reached] || 'H', `class="hit-label" font-size="${labelFont}" font-weight="700" text-anchor="end"`);
  return s;
}

function star(cx, cy, r) {
  const points = Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 ? r * 0.42 : r;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`;
  });
  return `<polygon class="mark-barrel" points="${points.join(' ')}" fill="#111"/>`;
}

// The three right-hand boxes: pitches this at-bat, a star if barreled, the pitcher's running total.
function sideBoxes(ab, x, y, g) {
  const cx = x + CELL_W - SIDE_W / 2;
  const font = `font-size="${g.markFont + 1}" font-weight="700" text-anchor="middle"`;
  const midY = y + (20 * g.k + g.upperH) / 2;
  let s = '';
  if (ab.pitches.length) s += text(cx, y + 10 * g.k + (g.markFont + 1) * 0.35, ab.pitches.length, `class="box-at-bat" ${font}`);
  if (ab.barrel) s += star(cx, midY, Math.min(10, (g.upperH - 20 * g.k) / 2 - 1));
  if (ab.pitcherTotal) s += text(cx, y + g.upperH + g.sqH + (g.markFont + 1) * 0.35, ab.pitcherTotal, `class="box-total" ${font}`);
  return s;
}

// Blue dot and name = new pitcher. Red dot and name = pinch hitter.
function changeLabel(cls, name, color, x, y) {
  const fit = name.length > 12 ? 'textLength="46" lengthAdjust="spacingAndGlyphs"' : '';
  return `<circle class="${cls}" cx="${x + 3}" cy="${y + 5}" r="2.6" fill="${color}"/>${text(x + 7.5, y + 7.5, name, `font-size="7.5" font-weight="700" fill="${color}" ${fit}`)}`;
}

function changeMarks(ab, x, y) {
  let s = '';
  if (ab.newPitcher) s += changeLabel('mark-new-pitcher', ab.newPitcher, BLUE, x + 1, y);
  if (ab.newBatter) s += changeLabel('mark-new-batter', ab.newBatter, HITTER_RED, x + 57, y);
  return s;
}

function outNumber(ab, x, y, g) {
  if (!ab.outNumber) return '';
  const cx = x + CELL_W - SIDE_W - 9 * Math.max(g.k, 0.8);
  // Sits lower when a new hitter's name is along the top of the box.
  const cy = y + (ab.newBatter ? 19 * g.k : 9 * Math.max(g.k, 0.8));
  const r = 6.5 * Math.max(g.k, 0.8);
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#111" stroke-width="1"/>${text(cx, cy + r * 0.45, ab.outNumber, 'font-size="9" font-weight="700" text-anchor="middle"')}`;
}

function circledChoice(options, value, x, y) {
  // Lays out e.g. "R / L / S", circling the chosen letter.
  let s = '';
  options.forEach((opt, i) => {
    const lx = x + i * 13;
    s += text(lx, y, opt, 'font-size="8" fill="#444" text-anchor="middle"');
    if (i < options.length - 1) s += text(lx + 6.5, y, '/', 'font-size="8" fill="#444" text-anchor="middle"');
    if (value === opt) s += `<circle cx="${lx}" cy="${y - 3}" r="5.5" fill="none" stroke="#111" stroke-width="1"/>`;
  });
  return s;
}

function lineupCell(player, subs, y, g) {
  let s = rect(LEFT, y, LINEUP_W, g.rowH, 1.2);
  s += text(LEFT + 3, y + 9, 'Player:', 'font-size="7.5" fill="#444"');
  s += text(LEFT + 3, y + Math.max(20, 38 * g.k), '#:', 'font-size="8" fill="#444"');
  const number = player.number ? `${player.number} ` : '';
  const names = [player.name, ...subs].filter(Boolean).join(' / ');
  const label = number + names;
  const fit = label.length > 13 ? `textLength="${LINEUP_W - 16}" lengthAdjust="spacingAndGlyphs"` : '';
  s += text(LEFT + 13, y + Math.max(21, 39 * g.k), label, `font-size="${g.k < 0.8 ? 12 : 13}" font-weight="600" ${fit}`);
  s += circledChoice(['R', 'L', 'S'], player.hand, LEFT + 8, y + 72 * g.k);
  s += circledChoice(['G', 'Y', 'R'], '', LEFT + 8, y + 88 * g.k);
  return s;
}

export function pageCount(result) {
  const maxCol = result.atBats.reduce((m, ab) => Math.max(m, ab.col), 0);
  return Math.floor(maxCol / COLS) + 1;
}

export function chartSVG(session, result, page = 0) {
  const { atBats, state, current } = result;
  const colOffset = page * COLS;
  const rows = state.size;
  const g = geometry(rows);
  let s = `<svg class="chart-page" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}" font-family="Arial, Helvetica, sans-serif" fill="#111">`;
  s += `<rect width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>`;

  s += `<image href="pitcher.png" x="${LEFT}" y="6" width="74" height="54" preserveAspectRatio="xMidYMid meet"/>`;
  s += text(PAGE.w / 2 + 25, 46, 'WABASH COLLEGE PITCHING CHART', `font-size="30" font-weight="700" font-style="italic" fill="${RED}" text-anchor="middle"`);
  s += line(LEFT, 62, PAGE.w - LEFT, 62, 1.6);

  s += text(LEFT, 106, 'Pitcher(s):', `font-size="10" fill="${RED}"`);
  s += line(LEFT + 50, 109, 395, 109);
  s += text(LEFT + 58, 105, state.pitchers.join(', '), 'font-size="14" font-weight="600"');
  s += text(405, 84, 'Opponent:', `font-size="10" fill="${RED}"`);
  s += line(455, 87, 680, 87);
  const fitOpponent = (session.opponent || '').length > 26 ? 'textLength="212" lengthAdjust="spacingAndGlyphs"' : '';
  s += text(463, 83, session.opponent, `font-size="14" font-weight="600" ${fitOpponent}`);
  s += text(690, 84, 'Date:', `font-size="10" fill="${RED}"`);
  s += line(718, 87, PAGE.w - LEFT, 87);
  s += text(724, 83, session.date, 'font-size="14" font-weight="600"');

  // Header row.
  s += rect(LEFT, ROWS_TOP - 16, LINEUP_W + COLS * CELL_W, 16, 1.2);
  s += text(LEFT + 3, ROWS_TOP - 5, page ? `LINEUP (page ${page + 1})` : 'LINEUP', 'font-size="9" font-weight="700"');
  for (let c = 0; c < COLS; c += 1) {
    const x = LEFT + LINEUP_W + c * CELL_W;
    s += line(x, ROWS_TOP - 16, x, ROWS_TOP);
    const nth = c + colOffset;
    const label = ORDINALS[nth] || `${nth + 1}th`;
    s += text(x + CELL_W / 2, ROWS_TOP - 5, `${label} At Bat`, `font-size="9" fill="${RED}" text-anchor="middle"`);
  }

  // Grid, lineup, and at-bats.
  for (let r = 0; r < rows; r += 1) {
    const y = ROWS_TOP + r * g.rowH;
    const first = atBats.find((ab) => ab.slot === r);
    const starter = (session.lineup || [])[r] || {};
    const player = { ...starter, hand: first?.hand || starter.hand };
    s += lineupCell(player, state.subs[r] || [], y, g);
    for (let c = 0; c < COLS; c += 1) {
      const x = LEFT + LINEUP_W + c * CELL_W;
      const ab = atBats.find((a) => a.slot === r && a.col === c + colOffset);
      const n = Math.max(8, ab ? ab.pitches.length : 0);
      if (ab && ab === current) s += `<rect class="current-cell" x="${x}" y="${y}" width="${CELL_W}" height="${g.rowH}" fill="#fff4c2"/>`;
      s += blankCell(x, y, g, n);
      s += rect(x, y, CELL_W, g.rowH, 1.2);
      if (ab) {
        s += zoneNumbers(ab, x, y, g);
        s += gridMarks(ab, x, y, (CELL_W - SIDE_W) / n, g);
        const spray = hitSpray(ab, x, y, g);
        s += spray || resultText(ab.result, x, y, g);
        s += changeMarks(ab, x, y);
        s += outNumber(ab, x, y, g);
        s += sideBoxes(ab, x, y, g);
      }
    }
  }

  const notesY = ROWS_TOP + rows * g.rowH + 8;
  s += rect(LEFT, notesY, LINEUP_W + COLS * CELL_W, PAGE.h - notesY - 12, 1.2);
  s += text(LEFT + 4, notesY + 12, 'Game Notes:', `font-size="9" font-weight="700" fill="${RED}"`);
  s += `<foreignObject x="${LEFT + 60}" y="${notesY + 2}" width="${LINEUP_W + COLS * CELL_W - 66}" height="${PAGE.h - notesY - 16}"><div xmlns="http://www.w3.org/1999/xhtml" style="font:11px Arial,sans-serif;color:#111;white-space:pre-wrap">${esc(session.notes)}</div></foreignObject>`;
  s += '</svg>';
  return s;
}
