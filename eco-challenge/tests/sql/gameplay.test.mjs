import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDb, dropTestDb, rpc, user, createUser, approveAll } from './helpers.mjs';

const DB = 'eco_test_gameplay';
const BANK_MUN = 'c0000000-0000-4000-8000-000000000001';
let pool, adminId, instrId;

before(async () => {
  pool = new pg.Pool({ connectionString: await createTestDb(DB), max: 5 });
  adminId = await createUser(pool, 'admin@test.local', 'admin');
  instrId = await createUser(pool, 'instructor@test.local', 'instructor');
  await approveAll(pool, adminId);
});
after(async () => { await pool.end(); await dropTestDb(DB); });

const A = { role: 'anon' };
const I = () => ({ role: 'authenticated', uid: instrId });

/** Adelanta el reloj de la ronda en curso (sólo para pruebas). */
async function shiftRound(gameId, secondsAgo) {
  await pool.query(
    `update public.rounds set started_at = now() - make_interval(secs => $2),
            ends_at = now() - make_interval(secs => $2) + make_interval(secs => duration_s)
      where game_id = $1 and status in ('running','paused')`, [gameId, secondsAgo]);
}
async function correctBins(roundId) {
  const { rows } = await pool.query('select item_id, correct_bin from public.round_items where round_id = $1', [roundId]);
  return Object.fromEntries(rows.map((r) => [r.item_id, r.correct_bin]));
}
const wrongBin = (bin) => (bin === 'verde' ? 'negro' : 'verde');

test('flujo completo: unión, ronda, respuestas, duplicados y cierre por tiempo', async () => {
  const g = await rpc(pool, I(), 'create_game', ['municipal', BANK_MUN, 'Inducción', 60, 100, 50, 5, 2, 'inmediata']);
  assert.match(g.code, /^\d{6}$/);
  assert.equal(g.status, 'lobby');

  // Alias
  await assert.rejects(rpc(pool, A, 'join_game', [g.code, 'a']), /ALIAS_INVALIDO/);
  await assert.rejects(rpc(pool, A, 'join_game', [g.code, '<script>']), /ALIAS_INVALIDO/);
  await assert.rejects(rpc(pool, A, 'join_game', ['000000', 'Ana']), /CODIGO_INVALIDO/);
  const ana = await rpc(pool, A, 'join_game', [g.code, '  Ana   María ']);
  assert.equal(ana.alias, 'Ana María');
  assert.match(ana.token, /^[0-9a-f]{64}$/);
  await assert.rejects(rpc(pool, A, 'join_game', [g.code, 'ana maría']), /ALIAS_EN_USO/);
  const luis = await rpc(pool, A, 'join_game', [g.code, 'Luis_01']);

  let st = await rpc(pool, A, 'player_state', [ana.token]);
  assert.equal(st.game.status, 'lobby');
  assert.equal(st.round, null);
  assert.equal(st.bins.length, 4);

  // Inicio de ronda: hay cuenta regresiva previa
  const round = await rpc(pool, I(), 'start_round', [g.id]);
  assert.equal(round.items, 5);
  st = await rpc(pool, A, 'player_state', [ana.token]);
  assert.equal(st.game.status, 'running');
  assert.equal(st.round.items.length, 5);
  for (const it of st.round.items) {
    assert.equal(it.correct_bin, null, 'no se revela el contenedor correcto');
    assert.equal(it.explanation, null);
  }
  const itemIds = st.round.items.map((i) => i.id);
  const bins = await correctBins(round.round_id);
  await assert.rejects(rpc(pool, A, 'submit_answer', [ana.token, round.round_id, itemIds[0], bins[itemIds[0]]]), /AUN_NO_INICIA/);

  // A mitad del tiempo (30 s de 60): bono = 50 * (1 - 0.5) = 25
  await shiftRound(g.id, 30);
  const r1 = await rpc(pool, A, 'submit_answer', [ana.token, round.round_id, itemIds[0], bins[itemIds[0]]]);
  assert.equal(r1.status, 'registrado');
  assert.equal(r1.is_correct, true);
  assert.ok(r1.points >= 124 && r1.points <= 125, `puntos ${r1.points}`);
  assert.ok(r1.explanation.length > 5);

  // Duplicado: se conserva la primera respuesta, aunque ahora elija otro contenedor
  const dup = await rpc(pool, A, 'submit_answer', [ana.token, round.round_id, itemIds[0], wrongBin(bins[itemIds[0]])]);
  assert.equal(dup.status, 'duplicado');
  assert.equal(dup.points, r1.points);
  assert.equal(dup.chosen_bin, bins[itemIds[0]]);
  const cnt = await pool.query('select count(*)::int n from public.answers where player_id = $1', [ana.player_id]);
  assert.equal(cnt.rows[0].n, 1);

  // Incorrecta: 0 puntos, retroalimentación con el contenedor correcto sólo a este jugador
  const r2 = await rpc(pool, A, 'submit_answer', [ana.token, round.round_id, itemIds[1], wrongBin(bins[itemIds[1]])]);
  assert.equal(r2.is_correct, false);
  assert.equal(r2.points, 0);
  assert.equal(r2.correct_bin, bins[itemIds[1]]);

  // Validaciones de entrada
  await assert.rejects(rpc(pool, A, 'submit_answer', [ana.token, round.round_id, itemIds[2], 'azul']), /CONTENEDOR_INVALIDO/);
  await assert.rejects(rpc(pool, A, 'submit_answer', [ana.token, round.round_id, 'b0000000-0000-4000-8000-000000000001', 'verde']),
    /ELEMENTO_INVALIDO/);
  await assert.rejects(rpc(pool, A, 'submit_answer', ['f'.repeat(64), round.round_id, itemIds[2], 'verde']), /SESION_INVALIDA/);

  // Luis responde todo correcto
  for (const id of itemIds) await rpc(pool, A, 'submit_answer', [luis.token, round.round_id, id, bins[id]]);

  // Pausa: se rechazan respuestas y el tiempo se congela
  const before = (await pool.query('select ends_at from public.rounds where id = $1', [round.round_id])).rows[0].ends_at;
  await rpc(pool, I(), 'pause_round', [g.id]);
  st = await rpc(pool, A, 'player_state', [ana.token]);
  assert.equal(st.game.status, 'paused');
  await assert.rejects(rpc(pool, A, 'submit_answer', [ana.token, round.round_id, itemIds[2], bins[itemIds[2]]]), /RONDA_PAUSADA/);
  await pool.query(`update public.rounds set paused_at = paused_at - interval '10 seconds' where id = $1`, [round.round_id]);
  await rpc(pool, I(), 'resume_round', [g.id]);
  const after = (await pool.query('select ends_at, paused_total_ms from public.rounds where id = $1', [round.round_id])).rows[0];
  assert.ok(after.ends_at - before >= 10000, 'el fin de ronda se desplaza por la pausa');
  assert.ok(after.paused_total_ms >= 10000);

  // Fin por tiempo (controlado por el servidor), incluido el margen de latencia
  await shiftRound(g.id, 62);
  await assert.rejects(rpc(pool, A, 'submit_answer', [ana.token, round.round_id, itemIds[2], bins[itemIds[2]]]), /TIEMPO_AGOTADO/);
  st = await rpc(pool, A, 'player_state', [ana.token]);
  assert.equal(st.game.status, 'between_rounds');
  assert.equal(st.round.status, 'ended');
  assert.ok(st.round.items.every((i) => i.correct_bin), 'al terminar se revelan las respuestas');
  assert.equal(st.leaderboard[0].alias, 'Luis_01');
  assert.equal(st.me.pos, 2);

  const hs = await rpc(pool, I(), 'host_state', [g.id]);
  assert.equal(hs.players.length, 2);
  assert.equal(hs.round.players_done, 1);
  assert.equal(hs.leaderboard[0].correct, 5);

  // Ronda 2 y límite de rondas
  await rpc(pool, I(), 'start_round', [g.id]);
  await assert.rejects(rpc(pool, I(), 'start_round', [g.id]), /ESTADO_INVALIDO/);
  await rpc(pool, I(), 'end_round', [g.id]);
  await assert.rejects(rpc(pool, I(), 'start_round', [g.id]), /SIN_RONDAS/);

  // Fin de partida y ganador
  await rpc(pool, I(), 'finish_game', [g.id]);
  st = await rpc(pool, A, 'player_state', [luis.token]);
  assert.equal(st.game.status, 'finished');
  assert.equal(st.me.pos, 1);
  await assert.rejects(rpc(pool, A, 'join_game', [g.code, 'Tarde']), /PARTIDA_FINALIZADA/);

  const res = await rpc(pool, I(), 'game_results', [g.id]);
  assert.equal(res.ranking.length, 2);
  assert.equal(res.answers.length, 7);
  const hist = await rpc(pool, I(), 'my_games', [10]);
  assert.equal(hist.find((x) => x.id === g.id).winner, 'Luis_01');

  // Cerrar libera el código y bloquea el acceso del jugador
  await rpc(pool, I(), 'close_game', [g.id]);
  st = await rpc(pool, A, 'player_state', [luis.token]);
  assert.equal(st.game.status, 'closed');
  assert.equal(st.round, undefined);
});

test('modo "al final": no se revela si acertó hasta terminar la ronda', async () => {
  const g = await rpc(pool, I(), 'create_game', ['municipal', BANK_MUN, null, 60, 100, 50, 3, 1, 'al_final']);
  const p = await rpc(pool, A, 'join_game', [g.code, 'Rosa']);
  const round = await rpc(pool, I(), 'start_round', [g.id]);
  await shiftRound(g.id, 5);
  const bins = await correctBins(round.round_id);
  const id = Object.keys(bins)[0];
  const r = await rpc(pool, A, 'submit_answer', [p.token, round.round_id, id, bins[id]]);
  assert.equal(r.status, 'registrado');
  assert.equal(r.is_correct, null);
  assert.equal(r.points, null);
  assert.equal(r.correct_bin, null);
  let st = await rpc(pool, A, 'player_state', [p.token]);
  assert.equal(st.me.score, 0, 'el puntaje de la ronda abierta no se muestra');
  assert.equal(st.round.my_answers[0].is_correct, null);
  await rpc(pool, I(), 'end_round', [g.id]);
  st = await rpc(pool, A, 'player_state', [p.token]);
  assert.ok(st.me.score > 100);
  assert.equal(st.round.my_answers[0].is_correct, true);
});

test('desempate: aciertos y luego menor tiempo acumulado', async () => {
  const g = await rpc(pool, I(), 'create_game', ['municipal', BANK_MUN, null, 60, 100, 0, 3, 1, 'inmediata']);
  const p1 = await rpc(pool, A, 'join_game', [g.code, 'Lento']);
  const p2 = await rpc(pool, A, 'join_game', [g.code, 'Rapido']);
  const p3 = await rpc(pool, A, 'join_game', [g.code, 'Sin']);
  const round = await rpc(pool, I(), 'start_round', [g.id]);
  const bins = await correctBins(round.round_id);
  const [i1, i2] = Object.keys(bins);
  // Sin bono por rapidez: ambos suman 200 puntos con 2 aciertos.
  await shiftRound(g.id, 40);
  await rpc(pool, A, 'submit_answer', [p1.token, round.round_id, i1, bins[i1]]);
  await rpc(pool, A, 'submit_answer', [p1.token, round.round_id, i2, bins[i2]]);
  await shiftRound(g.id, 10);
  await rpc(pool, A, 'submit_answer', [p2.token, round.round_id, i1, bins[i1]]);
  await rpc(pool, A, 'submit_answer', [p2.token, round.round_id, i2, bins[i2]]);
  await rpc(pool, A, 'submit_answer', [p3.token, round.round_id, i1, wrongBin(bins[i1])]);
  await rpc(pool, I(), 'finish_game', [g.id]);
  const res = await rpc(pool, I(), 'game_results', [g.id]);
  assert.deepEqual(res.ranking.map((r) => [r.alias, r.score, r.pos]),
    [['Rapido', 200, 1], ['Lento', 200, 2], ['Sin', 0, 3]]);
});

test('desempate por número de aciertos cuando el puntaje es igual', async () => {
  // Inserción directa para construir el caso: 2 aciertos sin bono (200) vs 1 acierto con base 200.
  const g = await rpc(pool, I(), 'create_game', ['municipal', BANK_MUN, null, 60, 100, 0, 3, 1, 'inmediata']);
  const a = await rpc(pool, A, 'join_game', [g.code, 'DosAciertos']);
  const b = await rpc(pool, A, 'join_game', [g.code, 'UnAcierto']);
  const round = await rpc(pool, I(), 'start_round', [g.id]);
  const ids = Object.keys(await correctBins(round.round_id));
  const ins = `insert into public.answers (game_id, round_id, item_id, player_id, chosen_bin, is_correct, points, response_ms)
               values ($1, $2, $3, $4, 'verde', $5, $6, $7)`;
  await pool.query(ins, [g.id, round.round_id, ids[0], a.player_id, true, 100, 9000]);
  await pool.query(ins, [g.id, round.round_id, ids[1], a.player_id, true, 100, 9000]);
  await pool.query(ins, [g.id, round.round_id, ids[0], b.player_id, true, 200, 1000]);
  const res = await rpc(pool, I(), 'game_results', [g.id]);
  assert.deepEqual(res.ranking.map((r) => [r.alias, r.pos]), [['DosAciertos', 1], ['UnAcierto', 2]]);
});

test('jugador expulsado: no responde ni aparece en el ranking', async () => {
  const g = await rpc(pool, I(), 'create_game', ['municipal']);
  const p = await rpc(pool, A, 'join_game', [g.code, 'Troll']);
  await rpc(pool, I(), 'kick_player', [g.id, p.player_id]);
  const round = await rpc(pool, I(), 'start_round', [g.id]);
  await shiftRound(g.id, 1);
  const bins = await correctBins(round.round_id);
  const id = Object.keys(bins)[0];
  await assert.rejects(rpc(pool, A, 'submit_answer', [p.token, round.round_id, id, bins[id]]), /EXPULSADO/);
  const st = await rpc(pool, A, 'player_state', [p.token]);
  assert.equal(st.player.kicked, true);
  const hs = await rpc(pool, I(), 'host_state', [g.id]);
  assert.equal(hs.leaderboard.length, 0);
});

test('sala llena y configuración bloqueada durante la ronda', async () => {
  const g = await rpc(pool, I(), 'create_game', ['municipal']);
  await pool.query('update public.games set max_players = 2 where id = $1', [g.id]);
  await rpc(pool, A, 'join_game', [g.code, 'Uno']);
  await rpc(pool, A, 'join_game', [g.code, 'Dos']);
  await assert.rejects(rpc(pool, A, 'join_game', [g.code, 'Tres']), /SALA_LLENA/);

  const upd = await rpc(pool, I(), 'update_game_settings', [g.id, 90, 120, 30, null, null, null]);
  assert.equal(upd.round_duration_s, 90);
  assert.equal(upd.base_points, 120);
  await assert.rejects(rpc(pool, I(), 'update_game_settings', [g.id, 90, null, 60, null, null, null]), /check constraint/);
  await rpc(pool, I(), 'start_round', [g.id]);
  await assert.rejects(rpc(pool, I(), 'update_game_settings', [g.id, 30, null, null, null, null, null]), /ESTADO_INVALIDO/);
  await rpc(pool, I(), 'end_round', [g.id]);
  await assert.rejects(rpc(pool, I(), 'update_game_settings', [g.id, null, 500, null, null, null, null]), /PUNTUACION_BLOQUEADA/);
});

test('las rondas priorizan residuos no usados y respetan el ámbito', async () => {
  const g = await rpc(pool, I(), 'create_game', ['no_municipal', null, null, 60, 100, 50, 10, 2, 'inmediata']);
  const r1 = await rpc(pool, I(), 'start_round', [g.id]);
  await rpc(pool, I(), 'end_round', [g.id]);
  const r2 = await rpc(pool, I(), 'start_round', [g.id]);
  const items = async (rid) => (await pool.query(
    `select ri.item_id, w.scope from public.round_items ri join public.waste_items w on w.id = ri.item_id
      where ri.round_id = $1`, [rid])).rows;
  const a = await items(r1.round_id);
  const b = await items(r2.round_id);
  assert.ok([...a, ...b].every((x) => x.scope === 'no_municipal'));
  const overlap = b.filter((x) => a.some((y) => y.item_id === x.item_id)).length;
  assert.equal(overlap, 0, '20 residuos disponibles: dos rondas de 10 sin repetir');
});

test('tema Riesgos Críticos: ámbito configurable, controles con texto largo y contenedores = riesgos', async () => {
  // Datos de ejemplo genéricos (no corresponden a ninguna empresa).
  await pool.query(`insert into public.scopes (code, theme, name, prompt, sort_order)
                    values ('rc_demo', 'riesgos', 'Riesgos críticos · Demo', 'Arrastra cada control a su riesgo crítico.', 10)`);
  await pool.query(`insert into public.bins (scope, code, color_name, label, color_hex, text_hex, icon, description, sort_order) values
    ('rc_demo', 'altura', 'RC-A', 'Trabajo en altura', '#1E63C6', '#FFFFFF', '🧗', 'Caídas a distinto nivel', 1),
    ('rc_demo', 'izaje', 'RC-B', 'Maniobras de izaje', '#7B4A2A', '#FFFFFF', '🏗️', 'Cargas suspendidas', 2)`);
  const admin = { role: 'authenticated', uid: adminId };
  const largo = 'Sistema de protección contra caídas certificado, inspeccionado antes de cada uso y anclado a un punto independiente verificado';
  assert.ok(largo.length > 80 && largo.length <= 160);
  assert.equal(await rpc(pool, admin, 'my_role'), 'admin');
  const ins = await user(pool, adminId,
    `insert into public.waste_items (name, scope, bin_code, image_url, explanation, status) values
       ($1, 'rc_demo', 'altura', '/img/riesgos/control.svg', 'Control del riesgo de trabajo en altura.', 'aprobado'),
       ('Plan de izaje aprobado', 'rc_demo', 'izaje', '/img/riesgos/control.svg', 'Control del riesgo de izaje.', 'aprobado')
     returning id`, [largo]);
  assert.equal(ins.rowCount, 2);
  // Un contenedor de residuos no es válido en este ámbito.
  await assert.rejects(user(pool, adminId,
    `insert into public.waste_items (name, scope, bin_code, image_url, explanation) values
       ('Algo', 'rc_demo', 'verde', '/img/x.svg', 'explicación')`), /foreign key/);

  const g = await rpc(pool, I(), 'create_game', ['rc_demo', null, 'Riesgos', 60, 100, 50, 5, 1, 'inmediata']);
  const p = await rpc(pool, A, 'join_game', [g.code, 'Operador']);
  const round = await rpc(pool, I(), 'start_round', [g.id]);
  assert.equal(round.items, 2);
  await shiftRound(g.id, 2);
  const st = await rpc(pool, A, 'player_state', [p.token]);
  assert.equal(st.game.theme, 'riesgos');
  assert.equal(st.game.scope_name, 'Riesgos críticos · Demo');
  assert.deepEqual(st.bins.map((b) => b.code), ['altura', 'izaje']);
  assert.ok(st.round.items.every((it) => it.correct_bin === null));
  const bins = await correctBins(round.round_id);
  const id = st.round.items.find((it) => it.name === largo).id;
  assert.equal(bins[id], 'altura');
  const r = await rpc(pool, A, 'submit_answer', [p.token, round.round_id, id, 'izaje']);
  assert.equal(r.is_correct, false);
  assert.equal(r.correct_bin, 'altura');
  await assert.rejects(rpc(pool, A, 'submit_answer', [p.token, round.round_id, id, 'verde']), /CONTENEDOR_INVALIDO/);
  const hs = await rpc(pool, I(), 'host_state', [g.id]);
  assert.equal(hs.scope_info.theme, 'riesgos');
  await assert.rejects(rpc(pool, I(), 'create_game', ['no_existe']), /AMBITO_REQUERIDO/);
});
