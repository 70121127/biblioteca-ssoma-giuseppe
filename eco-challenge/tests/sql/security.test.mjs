import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDb, dropTestDb, anon, user, rpc, createUser, approveAll } from './helpers.mjs';

const DB = 'eco_test_security';
let pool, adminId, instrId, otherInstrId, outsiderId;

before(async () => {
  pool = new pg.Pool({ connectionString: await createTestDb(DB), max: 5 });
  adminId = await createUser(pool, 'admin@test.local', 'admin');
  instrId = await createUser(pool, 'instructor@test.local', 'instructor');
  otherInstrId = await createUser(pool, 'otro@test.local', 'instructor');
  outsiderId = await createUser(pool, 'externo@test.local', null);
});
after(async () => { await pool.end(); await dropTestDb(DB); });

const A = () => ({ role: 'anon' });
const U = (uid) => ({ role: 'authenticated', uid });

test('anon sólo puede leer contenedores', async () => {
  const bins = await anon(pool, 'select count(*)::int as n from public.bins');
  assert.equal(bins.rows[0].n, 11);
  for (const t of ['waste_items', 'games', 'players', 'answers', 'rounds', 'round_items', 'staff', 'question_banks']) {
    await assert.rejects(anon(pool, `select * from public.${t}`), /permission denied/, t);
  }
  await assert.rejects(anon(pool, `insert into public.bins (scope, code, color_name, label, color_hex, text_hex, icon, description, sort_order)
                                    values ('municipal','azul','x','x','#000000','#000000','x','x',9)`), /permission denied/);
});

test('anon no puede ejecutar funciones del instructor ni internas', async () => {
  await assert.rejects(rpc(pool, A(), 'create_game', ['municipal']), /permission denied/);
  await assert.rejects(rpc(pool, A(), 'my_games', [10]), /permission denied/);
  await assert.rejects(anon(pool, `select * from public._scores(gen_random_uuid())`), /permission denied/);
  await assert.rejects(anon(pool, `select public._sync_game(gen_random_uuid())`), /permission denied/);
});

test('un usuario autenticado sin rol de personal no tiene acceso', async () => {
  await assert.rejects(rpc(pool, U(outsiderId), 'create_game', ['municipal']), /NO_AUTORIZADO/);
  const items = await user(pool, outsiderId, 'select count(*)::int as n from public.waste_items');
  assert.equal(items.rows[0].n, 0, 'RLS oculta el banco');
  await assert.rejects(user(pool, outsiderId, `insert into public.waste_items (name, scope, bin_code, image_url, explanation)
     values ('Prueba', 'municipal', 'verde', '/img/x.svg', 'explicación')`), /row-level security/);
  await assert.rejects(rpc(pool, U(outsiderId), 'admin_set_role', ['externo@test.local', 'admin']), /NO_AUTORIZADO/);
});

test('los ejemplos iniciales quedan pendientes de validación', async () => {
  const r = await user(pool, adminId, `select status, count(*)::int n from public.waste_items group by status`);
  assert.deepEqual(r.rows, [{ status: 'pendiente', n: 37 }]);
  await assert.rejects(rpc(pool, U(instrId), 'create_game', ['municipal']), /BANCO_VACIO/);
});

test('validación por administrador: el instructor no puede aprobar', async () => {
  const ins = await user(pool, instrId, `insert into public.waste_items (name, scope, bin_code, image_url, explanation, status)
     values ('Vaso de papel', 'municipal', 'verde', '/img/residuos/papel.svg', 'Ejemplo de prueba', 'aprobado') returning id, status`);
  const id = ins.rows[0].id;
  assert.equal(ins.rows[0].status, 'pendiente');

  await user(pool, instrId, `update public.waste_items set status = 'aprobado' where id = $1`, [id]);
  let s = await pool.query('select status from public.waste_items where id = $1', [id]);
  assert.equal(s.rows[0].status, 'pendiente');

  await user(pool, adminId, `update public.waste_items set status = 'aprobado' where id = $1`, [id]);
  s = await pool.query('select status, validated_by from public.waste_items where id = $1', [id]);
  assert.equal(s.rows[0].status, 'aprobado');
  assert.equal(s.rows[0].validated_by, adminId);

  // Cambiar el contenedor (no-admin) obliga a re-validar.
  await user(pool, instrId, `update public.waste_items set bin_code = 'negro' where id = $1`, [id]);
  s = await pool.query('select status, validated_by from public.waste_items where id = $1', [id]);
  assert.equal(s.rows[0].status, 'pendiente');
  assert.equal(s.rows[0].validated_by, null);

  // Activar/desactivar no requiere re-validación.
  await user(pool, adminId, `update public.waste_items set status = 'aprobado' where id = $1`, [id]);
  await user(pool, instrId, `update public.waste_items set active = false where id = $1`, [id]);
  s = await pool.query('select status, active from public.waste_items where id = $1', [id]);
  assert.deepEqual(s.rows[0], { status: 'aprobado', active: false });

  await assert.rejects(user(pool, instrId, `delete from public.waste_items where id = $1 returning id`, [id])
    .then((r) => { if (r.rowCount === 0) throw new Error('row-level security: sin filas'); }), /row-level security/);
  await user(pool, adminId, `delete from public.waste_items where id = $1`, [id]);
});

test('URLs de imagen inseguras e imágenes externas sin licencia se rechazan', async () => {
  await assert.rejects(user(pool, adminId, `insert into public.waste_items (name, scope, bin_code, image_url, explanation)
     values ('Prueba', 'municipal', 'verde', 'javascript:alert(1)', 'explicación')`), /check constraint/);
  await assert.rejects(user(pool, adminId, `insert into public.waste_items (name, scope, bin_code, image_url, image_source, explanation)
     values ('Prueba', 'municipal', 'verde', 'https://example.com/a.png', 'externa_autorizada', 'explicación')`), /check constraint/);
  // Contenedor que no existe en el ámbito (azul es sólo no municipal).
  await assert.rejects(user(pool, adminId, `insert into public.waste_items (name, scope, bin_code, image_url, explanation)
     values ('Prueba', 'municipal', 'azul', '/img/x.svg', 'explicación')`), /foreign key/);
});

test('no se mezclan ámbitos en un banco ni en una partida', async () => {
  await assert.rejects(user(pool, adminId, `insert into public.bank_items (bank_id, item_id)
     values ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')`), /AMBITO_DISTINTO/);
  await approveAll(pool, adminId);
  await assert.rejects(rpc(pool, U(instrId), 'create_game', ['no_municipal', 'c0000000-0000-4000-8000-000000000001']),
    /AMBITO_DISTINTO/);
  await assert.rejects(rpc(pool, U(instrId), 'create_game', ['ambos']), /AMBITO_REQUERIDO/);
  await assert.rejects(user(pool, adminId, `update public.waste_items set scope = 'no_municipal', bin_code = 'azul'
     where id = 'a0000000-0000-4000-8000-000000000001'`), /AMBITO_EN_USO/);
});

test('un instructor no ve ni controla partidas de otro', async () => {
  const g = await rpc(pool, U(instrId), 'create_game', ['municipal', 'c0000000-0000-4000-8000-000000000001', 'Mía']);
  await assert.rejects(rpc(pool, U(otherInstrId), 'host_state', [g.id]), /PARTIDA_NO_ENCONTRADA/);
  await assert.rejects(rpc(pool, U(otherInstrId), 'start_round', [g.id]), /PARTIDA_NO_ENCONTRADA/);
  const vis = await user(pool, otherInstrId, 'select count(*)::int n from public.games where id = $1', [g.id]);
  assert.equal(vis.rows[0].n, 0);
  const own = await user(pool, instrId, 'select count(*)::int n from public.games where id = $1', [g.id]);
  assert.equal(own.rows[0].n, 1);
  // El admin sí puede supervisar.
  const hs = await rpc(pool, U(adminId), 'host_state', [g.id]);
  assert.equal(hs.game.id, g.id);
  // Nadie escribe directamente en las tablas de juego.
  await assert.rejects(user(pool, instrId, `update public.games set status = 'finished' where id = $1`, [g.id]),
    /permission denied/);
});

test('el token del participante no es legible ni por el instructor', async () => {
  const g = await rpc(pool, U(instrId), 'create_game', ['municipal']);
  await rpc(pool, A(), 'join_game', [g.code, 'Ana']);
  await assert.rejects(user(pool, instrId, 'select token_hash from public.players'), /permission denied/);
  const ok = await user(pool, instrId, 'select alias from public.players where game_id = $1', [g.id]);
  assert.deepEqual(ok.rows, [{ alias: 'Ana' }]);
  await assert.rejects(rpc(pool, A(), 'player_state', ['0'.repeat(64)]), /SESION_INVALIDA/);
  await assert.rejects(rpc(pool, A(), 'player_state', ["' or 1=1 --"]), /SESION_INVALIDA/);
});

test('gestión de personal sólo por administrador', async () => {
  await createUser(pool, 'nuevo@test.local', null);
  await assert.rejects(rpc(pool, U(instrId), 'admin_set_role', ['nuevo@test.local', 'instructor']), /NO_AUTORIZADO/);
  const list = await rpc(pool, U(adminId), 'admin_set_role', ['nuevo@test.local', 'instructor']);
  assert.ok(list.some((s) => s.email === 'nuevo@test.local' && s.role === 'instructor'));
  await assert.rejects(rpc(pool, U(adminId), 'admin_set_role', ['admin@test.local', 'instructor']), /NO_PUEDE_QUITARSE_ADMIN/);
  await assert.rejects(user(pool, instrId, `insert into public.staff (user_id, role) values ($1, 'admin')`, [outsiderId]),
    /row-level security/);
});
