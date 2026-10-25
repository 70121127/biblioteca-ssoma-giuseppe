// Prueba de carga de la LÓGICA DE BASE DE DATOS con N participantes simulados.
// Ejecuta las mismas funciones RPC que usa la app, con el rol `anon`, sobre un
// PostgreSQL local y un pool de conexiones similar al de Supabase.
// NO mide Realtime ni la red de Supabase: para eso use simulate-supabase.mjs.
//
// Uso: node tests/load/simulate-db.mjs [50 100 200]
import pg from 'pg';
import assert from 'node:assert/strict';
import { createTestDb, dropTestDb, rpc, createUser, approveAll } from '../sql/helpers.mjs';

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const SIZES = sizes.length ? sizes : [50, 100, 200];
const POOL = Number(process.env.LOAD_POOL || 20);
const ITEMS = 8;
const DB = 'eco_test_load';

const A = { role: 'anon' };
const stats = {};
async function timed(kind, fn) {
  const t = performance.now();
  try { return await fn(); } finally { (stats[kind] ||= []).push(performance.now() - t); }
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(pool, instr, n) {
  for (const k of Object.keys(stats)) delete stats[k];
  const I = { role: 'authenticated', uid: instr };
  const g = await rpc(pool, I, 'create_game', ['municipal', null, `Carga ${n}`, 60, 100, 50, ITEMS, 1, 'inmediata']);
  const t0 = performance.now();

  // 1) Unión simultánea
  const players = await Promise.all(Array.from({ length: n }, (_, i) =>
    timed('join_game', () => rpc(pool, A, 'join_game', [g.code, `Jugador ${String(i + 1).padStart(3, '0')}`]))));
  const tJoin = performance.now() - t0;

  // 2) Inicio de ronda y sondeo de estado de todos
  const round = await rpc(pool, I, 'start_round', [g.id]);
  await pool.query(`update public.rounds set started_at = now() - interval '1 second',
                      ends_at = now() - interval '1 second' + make_interval(secs => duration_s) where id = $1`, [round.round_id]);
  const states = await Promise.all(players.map((p) => timed('player_state', () => rpc(pool, A, 'player_state', [p.token]))));
  assert.ok(states.every((s) => s.round.items.length === ITEMS && s.round.items.every((it) => it.correct_bin === null)));
  const truth = Object.fromEntries((await pool.query('select item_id, correct_bin from public.round_items where round_id = $1',
    [round.round_id])).rows.map((r) => [r.item_id, r.correct_bin]));
  const binsList = ['verde', 'marron', 'negro', 'rojo'];

  // 3) Respuestas concurrentes (≈70 % correctas) + 1 de cada 5 reintenta la misma respuesta
  const t1 = performance.now();
  let duplicatesTried = 0;
  const hostPolls = [];
  let answering = true;
  (async () => { while (answering) { hostPolls.push(await timed('host_state', () => rpc(pool, I, 'host_state', [g.id]))); await sleep(1500); } })();
  await Promise.all(players.map(async (p, idx) => {
    const items = states[idx].round.items.map((i) => i.id);
    for (const id of items) {
      await sleep(Math.random() * 250);
      const bin = Math.random() < 0.7 ? truth[id] : binsList.find((b) => b !== truth[id]);
      const r = await timed('submit_answer', () => rpc(pool, A, 'submit_answer', [p.token, round.round_id, id, bin]));
      assert.equal(r.status, 'registrado');
      if (idx % 5 === 0) {
        duplicatesTried++;
        const d = await timed('submit_answer(dup)', () => rpc(pool, A, 'submit_answer', [p.token, round.round_id, id, truth[id]]));
        assert.equal(d.status, 'duplicado');
      }
    }
  }));
  answering = false;
  const tAnswers = performance.now() - t1;

  // 4) Verificaciones de integridad
  const { rows: [c] } = await pool.query(
    `select count(*)::int total, count(distinct (player_id, item_id))::int unicos,
            sum(points)::int puntos, count(*) filter (where is_correct and points < 100)::int malos,
            count(*) filter (where not is_correct and points <> 0)::int malos2
       from public.answers where round_id = $1`, [round.round_id]);
  assert.equal(c.total, n * ITEMS, 'una respuesta por residuo y participante');
  assert.equal(c.unicos, c.total, 'sin duplicados');
  assert.equal(c.malos + c.malos2, 0, 'puntajes coherentes');

  await rpc(pool, I, 'end_round', [g.id]);
  await rpc(pool, I, 'finish_game', [g.id]);
  const res = await rpc(pool, I, 'game_results', [g.id]);
  assert.equal(res.ranking.length, n);
  assert.equal(res.ranking.reduce((s, r) => s + Number(r.score), 0), c.puntos, 'el ranking suma lo mismo que las respuestas');
  for (let i = 1; i < res.ranking.length; i++) {
    const a = res.ranking[i - 1]; const b = res.ranking[i];
    const ordered = a.score > b.score || (a.score === b.score && (a.correct > b.correct
      || (a.correct === b.correct && a.correct_ms <= b.correct_ms)));
    assert.ok(ordered, `orden del ranking en posición ${i}`);
  }
  const final = await Promise.all(players.slice(0, 20).map((p) => rpc(pool, A, 'player_state', [p.token])));
  assert.ok(final.every((s) => s.game.status === 'finished' && s.leaderboard.length === Math.min(10, n)));

  return { n, tJoin, tAnswers, answers: c.total, duplicatesTried, hostPolls: hostPolls.length,
    winner: res.ranking[0], stats: Object.fromEntries(Object.entries(stats).map(([k, v]) =>
      [k, { n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v) }])) };
}

async function main() {
  console.log(`PostgreSQL local · pool de ${POOL} conexiones · ${ITEMS} residuos por ronda`);
  const pool = new pg.Pool({ connectionString: await createTestDb(DB), max: POOL });
  try {
    const admin = await createUser(pool, 'admin@load.local', 'admin');
    const instr = await createUser(pool, 'instructor@load.local', 'instructor');
    await approveAll(pool, admin);
    for (const n of SIZES) {
      const r = await scenario(pool, instr, n);
      console.log(`\n=== ${n} participantes: OK ===`);
      console.log(`unión de todos: ${r.tJoin.toFixed(0)} ms · ${r.answers} respuestas en ${r.tAnswers.toFixed(0)} ms` +
        ` · ${r.duplicatesTried} duplicados rechazados · ganador ${r.winner.alias} (${r.winner.score} pts)`);
      console.table(Object.fromEntries(Object.entries(r.stats).map(([k, v]) =>
        [k, { llamadas: v.n, 'p50 ms': v.p50.toFixed(1), 'p95 ms': v.p95.toFixed(1), 'máx ms': v.max.toFixed(1) }])));
    }
  } finally {
    await pool.end();
    await dropTestDb(DB);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
