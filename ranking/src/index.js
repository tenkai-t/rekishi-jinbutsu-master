// 歴史人物マスター - online ranking API (Cloudflare Worker + D1)
// Routes:
//   GET  /            -> "ok"
//   GET  /ranking?mode=10|survival&course=any|all|japan|world|sengoku&period=all|month&uuid=<device uuid>
//                     -> { top: [...10], myRank, myBest, mode, course, period }
//   POST /scores      -> { uuid, name, score, correct, count, course, mode, level } を登録し { ok, id, rank } を返す
// 部門（ボード）: 出題数モード × コース。並び順は
//   mode=10       : score 降順 → correct 降順 → 登録が早い順
//   mode=survival : correct 降順 → score 降順 → 登録が早い順
const ALLOW_ORIGIN = 'https://tenkai-t.github.io';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}
function validUuid(v) {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
}
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  const len = [...name].length;
  if (len < 1 || len > 12) return null;
  return name;
}
const NG_WORDS=['しね','死ね','ころす','殺す','くそ','ばか','あほ','きちがい','ちんこ','ちんちん','まんこ','おっぱい','せっくす','うんこ','うんち','じさつ','自殺','fuck','shit','dick','pussy','bitch','porn','sex'];
function normalizeName(s){return String(s).replace(/[！-～]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0)).toLowerCase().replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60)).replace(/[\s　・_.\-~〜]/g,'')}
function isNgName(name){const n=normalizeName(name);return NG_WORDS.some(w=>n.includes(normalizeName(w)))}
function intIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}
const COURSES = ['all', 'japan', 'world', 'sengoku'];
const MODES = ['10', 'survival'];
// 並び順の主キー・副キー（mode で入れ替わる）
function sortKeys(mode) {
  return mode === 'survival' ? ['correct', 'score'] : ['score', 'correct'];
}
function orderClause(mode) {
  const [a, b] = sortKeys(mode);
  return `${a} DESC, ${b} DESC, created_at ASC, id ASC`;
}
// row より上位の件数を数えて順位を返す。board = { mode, course|null(any), range|null }
async function rankOf(db, row, board) {
  const [a, b] = sortKeys(row.mode);
  const conds = ['mode = ?'];
  const binds = [row.mode];
  if (board.course) { conds.push('course = ?'); binds.push(board.course); }
  if (board.range) { conds.push('created_at >= ? AND created_at < ?'); binds.push(board.range.start, board.range.end); }
  const better =
    `(${a} > ? OR (${a} = ? AND ${b} > ?) OR (${a} = ? AND ${b} = ? AND created_at < ?) OR (${a} = ? AND ${b} = ? AND created_at = ? AND id < ?))`;
  conds.push(better);
  binds.push(row[a], row[a], row[b], row[a], row[b], row.created_at, row[a], row[b], row.created_at, row.id);
  const r = await db.prepare(`SELECT COUNT(*) AS c FROM scores WHERE ${conds.join(' AND ')}`).bind(...binds).first();
  return (r ? r.c : 0) + 1;
}
// 日本時間（JST）での今月の範囲を UTC の ISO 文字列で返す
function monthRangeJST(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1) - 9 * 3600 * 1000);
  const end = new Date(Date.UTC(y, m + 1, 1) - 9 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString(), label: y + '-' + String(m + 1).padStart(2, '0') };
}
function rowOut(e) {
  return { id: e.id, name: e.name, score: e.score, correct: e.correct, count: e.count, course: e.course, level: e.level, date: e.created_at };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() } });
      }
      if (url.pathname === '/ranking' && request.method === 'GET') {
        const mode = url.searchParams.get('mode') || '10';
        if (!MODES.includes(mode)) return json({ error: 'invalid mode' }, 400);
        const courseParam = url.searchParams.get('course') || 'any';
        if (courseParam !== 'any' && !COURSES.includes(courseParam)) return json({ error: 'invalid course' }, 400);
        const course = courseParam === 'any' ? null : courseParam;
        const range = url.searchParams.get('period') === 'month' ? monthRangeJST() : null;
        const conds = ['mode = ?'];
        const binds = [mode];
        if (course) { conds.push('course = ?'); binds.push(course); }
        if (range) { conds.push('created_at >= ? AND created_at < ?'); binds.push(range.start, range.end); }
        const where = conds.join(' AND ');
        const top = await env.DB.prepare(
          `SELECT id, name, score, correct, count, course, level, created_at FROM scores WHERE ${where} ORDER BY ${orderClause(mode)} LIMIT 10`
        ).bind(...binds).all();
        let myRank = null, myBest = null;
        const uuid = url.searchParams.get('uuid');
        if (validUuid(uuid)) {
          const best = await env.DB.prepare(
            `SELECT id, name, score, correct, count, course, mode, level, created_at FROM scores WHERE uuid = ? AND ${where} ORDER BY ${orderClause(mode)} LIMIT 1`
          ).bind(uuid, ...binds).first();
          if (best) {
            myBest = rowOut(best);
            myRank = await rankOf(env.DB, best, { course, range });
          }
        }
        return json({
          top: (top.results || []).map(rowOut),
          myRank, myBest,
          mode, course: courseParam,
          period: range ? 'month' : 'all',
          ...(range ? { month: range.label } : {}),
        });
      }
      if (url.pathname === '/scores' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
        const uuid = body && body.uuid;
        const name = body && cleanName(body.name);
        const score = body && body.score;
        const correct = body && body.correct;
        const count = body && body.count;
        const course = body && body.course;
        const mode = body && body.mode;
        const level = body && body.level;
        if (!validUuid(uuid)) return json({ error: 'invalid uuid' }, 400);
        if (name === null) return json({ error: 'invalid name' }, 400);
        if (isNgName(name)) return json({ error: 'name not allowed' }, 400);
        if (!MODES.includes(mode)) return json({ error: 'invalid mode' }, 400);
        if (!COURSES.includes(course)) return json({ error: 'invalid course' }, 400);
        if (!intIn(level, 0, 5)) return json({ error: 'invalid level' }, 400);
        if (!intIn(count, 1, 500)) return json({ error: 'invalid count' }, 400);
        if (!intIn(correct, 0, 500) || correct > count) return json({ error: 'invalid correct' }, 400);
        if (mode === '10' && count !== 10) return json({ error: 'invalid count for mode' }, 400);
        // 1問の最大得点は 250 点（レベル5・ヒント1つ・連続正解・時間ボーナス最大）なので、それを超えるスコアは不正
        if (!intIn(score, 0, 999999) || score > 250 * count) return json({ error: 'invalid score' }, 400);
        // 送信頻度のつじつまチェック: 同一端末から5秒未満の再送信は受け付けない
        const last = await env.DB.prepare('SELECT created_at FROM scores WHERE uuid = ? ORDER BY id DESC LIMIT 1').bind(uuid).first();
        const now = new Date();
        if (last && now - new Date(last.created_at) < 5000) return json({ error: 'too fast' }, 429);
        const created_at = now.toISOString();
        const ins = await env.DB.prepare(
          'INSERT INTO scores (uuid, name, score, correct, count, course, mode, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(uuid, name, score, correct, count, course, mode, level, created_at).run();
        const id = ins.meta.last_row_id;
        const rank = await rankOf(env.DB, { id, mode, course, score, correct, created_at }, { course, range: null });
        return json({ ok: true, id, rank });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
  },
};
