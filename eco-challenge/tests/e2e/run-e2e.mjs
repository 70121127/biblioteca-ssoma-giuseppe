// Prueba de extremo a extremo en navegador (Playwright + Chromium):
// app compilada → pasarela local → PostgREST → PostgreSQL con las migraciones.
// Requiere PostgreSQL local y el binario de PostgREST (variable POSTGREST_BIN).
// Realtime no está disponible en este entorno: se verifica el modo de sondeo.
//
// Uso: POSTGREST_BIN=/ruta/postgrest npm run test:e2e
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import { build, preview } from 'vite';
import { chromium, devices } from 'playwright';
import { createTestDb, dropTestDb, root } from '../sql/helpers.mjs';
import { startGateway, signJwt } from './local-gateway.mjs';

const DB = 'eco_test_e2e';
const SECRET = 'prueba-local-e2e-secreto-de-al-menos-32-caracteres';
const GATEWAY = 3900;
const PGRST = 3901;
const WEB = 4173;
const SHOTS = process.env.E2E_SHOTS || join(root, 'docs', 'capturas');
const USERS = {
  'admin@e2e.local': { id: '11111111-1111-4111-8111-111111111111', password: 'Admin-123', role: 'admin' },
  'instructor@e2e.local': { id: '22222222-2222-4222-8222-222222222222', password: 'Instr-123', role: 'instructor' },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

async function waitFor(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* reintento */ }
    if (Date.now() > end) throw new Error('tiempo de espera agotado');
    await sleep(step);
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const dbUrl = await createTestDb(DB);
  const db = new pg.Pool({ connectionString: dbUrl, max: 3 });
  for (const [email, u] of Object.entries(USERS)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [u.id, email]);
    await db.query('insert into public.staff (user_id, role) values ($1, $2)', [u.id, u.role]);
  }

  const pgrst = spawn(process.env.POSTGREST_BIN || 'postgrest', [], {
    env: { ...process.env,
      PGRST_DB_URI: dbUrl.replace('postgres:postgres@', 'authenticator:authenticator@'),
      PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET,
      PGRST_SERVER_PORT: String(PGRST), PGRST_LOG_LEVEL: 'error' },
    stdio: ['ignore', 'inherit', 'inherit'] });
  const gateway = await startGateway({ port: GATEWAY, postgrestPort: PGRST, secret: SECRET, users: USERS });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PGRST}/`)).ok, 15000);
  log('PostgREST listo');

  const anonKey = signJwt({ role: 'anon', iss: 'e2e', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 }, SECRET);
  process.env.VITE_SUPABASE_URL = `http://127.0.0.1:${GATEWAY}`;
  process.env.VITE_SUPABASE_ANON_KEY = anonKey;
  process.env.VITE_PUBLIC_SITE_URL = '';
  await build({ root, logLevel: 'warn', build: { outDir: 'dist-e2e', emptyOutDir: true } });
  const web = await preview({ root, logLevel: 'warn', build: { outDir: 'dist-e2e' }, preview: { port: WEB, strictPort: true, host: '127.0.0.1' } });
  const BASE = `http://127.0.0.1:${WEB}`;
  log('App compilada y servida en', BASE);

  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, name) => {
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  };

  try {
    // ---------------- Administrador: validar banco y registrar un residuo ----------------
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const admin = await adminCtx.newPage();
    watch(admin, 'admin');
    await admin.goto(`${BASE}/admin.html`);
    await admin.fill('input[type=email]', 'admin@e2e.local');
    await admin.fill('input[type=password]', 'Admin-123');
    await admin.click('button[type=submit]');
    await admin.waitForSelector('.item-card');
    assert.equal(await admin.locator('.badge-pendiente').count(), 37, '37 ejemplos pendientes');
    await admin.screenshot({ path: join(SHOTS, '01-admin-banco-pendiente.png') });

    await admin.click('text=Nuevo residuo');
    const dlg = admin.locator('dialog');
    await dlg.locator('label:has-text("Nombre del residuo") input').fill('Vaso descartable de papel');
    await dlg.locator('label:has-text("Ámbito de gestión") select').selectOption('municipal');
    await dlg.locator('label:has-text("Contenedor correcto") select').selectOption('verde');
    await dlg.locator('label:has-text("Ruta o URL") input').fill('/img/residuos/papel.svg');
    await dlg.locator('label:has-text("Explicación") textarea').fill('Si está limpio y seco, el vaso de papel es aprovechable.');
    await dlg.locator('.preview-card img').waitFor();
    await admin.screenshot({ path: join(SHOTS, '02-admin-editor-vista-previa.png') });
    await dlg.locator('text=Guardar y aprobar').click();
    await admin.waitForSelector('dialog', { state: 'detached' });
    log('Residuo nuevo registrado y aprobado desde el editor');

    await admin.click('text=Seleccionar visibles');
    await admin.click('text=/Aprobar seleccionados/');
    await waitFor(async () => (await admin.locator('.badge-pendiente').count()) === 0);
    const { rows: [st] } = await db.query(`select count(*) filter (where status='aprobado')::int a, count(*)::int t from public.waste_items`);
    assert.equal(st.a, st.t);
    log(`Administrador aprobó ${st.a} residuos`);
    await admin.screenshot({ path: join(SHOTS, '03-admin-banco-aprobado.png') });

    // ---------------- Instructor: crear partida ----------------
    const hostCtx = await browser.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
    const host = await hostCtx.newPage();
    watch(host, 'instructor');
    await host.goto(`${BASE}/instructor.html`);
    await host.fill('input[type=email]', 'instructor@e2e.local');
    await host.fill('input[type=password]', 'mala');
    await host.click('button[type=submit]');
    await host.waitForSelector('text=Correo o contraseña incorrectos.');
    await host.fill('input[type=password]', 'Instr-123');
    await host.click('button[type=submit]');
    await host.waitForSelector('text=Nueva partida');
    await host.check('input[name=scope][value=municipal]');
    const bankValue = await host.$eval('select[name=bank]', (s) => [...s.options].find((o) => o.text.includes('Básico · Ámbito municipal')).value);
    await host.selectOption('select[name=bank]', bankValue);
    await host.fill('input[name=title]', 'Inducción SSOMA – Prueba E2E');
    await host.fill('input[name=duration]', '25');
    await host.fill('input[name=items]', '4');
    await host.fill('input[name=rounds]', '2');
    await host.screenshot({ path: join(SHOTS, '04-instructor-nueva-partida.png') });
    await host.click('text=Crear partida');
    const code = (await host.locator('.code-big').innerText({ timeout: 10000 })).trim();
    assert.match(code, /^\d{6}$/);
    assert.ok(await host.locator('img.qr-big[src^="data:image/png"]').count(), 'QR generado');
    log('Partida creada con código', code);

    // ---------------- Participantes desde celulares ----------------
    const phone = devices['Pixel 7'];
    const aliases = ['Ana', 'Bruno', 'Carla'];
    const players = [];
    for (const alias of aliases) {
      const ctx = await browser.newContext({ ...phone });
      const p = await ctx.newPage();
      watch(p, alias);
      await p.goto(`${BASE}/jugar.html?code=${code}`);
      await p.fill('input[autocomplete=nickname]', alias);
      await p.click('text=¡Entrar!');
      await p.waitForSelector(`text=¡Estás dentro, ${alias}!`);
      players.push({ alias, ctx, page: p });
    }
    // Alias repetido
    {
      const ctx = await browser.newContext({ ...phone });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/jugar.html?code=${code}`);
      await p.fill('input[autocomplete=nickname]', 'ana');
      await p.click('text=¡Entrar!');
      await p.waitForSelector('text=Ese alias ya está en uso');
      await ctx.close();
    }
    await players[0].page.screenshot({ path: join(SHOTS, '05-jugador-sala-espera.png') });
    await host.waitForSelector('text=Participantes: 3');
    await host.screenshot({ path: join(SHOTS, '06-instructor-sala-qr.png') });
    log('3 participantes en la sala (alias duplicado rechazado)');

    // ---------------- Ronda 1 ----------------
    await host.click('text=Iniciar ronda 1');
    for (const pl of players) await pl.page.waitForSelector('.waste-card', { timeout: 15000 });
    const truth = async () => Object.fromEntries((await db.query(
      `select ri.item_id, ri.correct_bin from public.round_items ri join public.rounds r on r.id = ri.round_id
         join public.games g on g.id = r.game_id where g.code = $1 and r.round_no = g.current_round`, [code])).rows
      .map((r) => [r.item_id, r.correct_bin]));
    const t1 = await truth();
    assert.equal(Object.keys(t1).length, 4);
    // El navegador del jugador no recibe la respuesta correcta.
    for (const pl of players) await pl.page.waitForSelector('.overlay', { state: 'hidden', timeout: 10000 });

    // Ana: toque en residuo y luego en contenedor (todo correcto)
    const ana = players[0].page;
    for (const [id, bin] of Object.entries(t1)) {
      await ana.click(`.waste-card[data-item="${id}"]`);
      await ana.click(`.bins-dock [data-bin="${bin}"]`);
      await ana.waitForSelector(`.waste-card[data-item="${id}"].done`);
    }
    assert.equal(await ana.locator('.waste-card.ok').count(), 4);
    await ana.screenshot({ path: join(SHOTS, '07-jugador-retroalimentacion.png') });
    log('Ana clasificó 4/4 por toque');

    // Bruno: arrastrar y soltar (2 correctas y 2 incorrectas)
    const bruno = players[1].page;
    let i = 0;
    for (const [id, bin] of Object.entries(t1)) {
      const target = i++ % 2 === 0 ? bin : (bin === 'rojo' ? 'verde' : 'rojo');
      const card = await bruno.locator(`.waste-card[data-item="${id}"]`).boundingBox();
      const dest = await bruno.locator(`.bins-dock [data-bin="${target}"]`).boundingBox();
      await bruno.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
      await bruno.mouse.down();
      await bruno.mouse.move(card.x + card.width / 2 + 20, card.y + card.height / 2 + 20, { steps: 3 });
      await bruno.mouse.move(dest.x + dest.width / 2, dest.y + dest.height / 2, { steps: 8 });
      await bruno.mouse.up();
      await bruno.waitForSelector(`.waste-card[data-item="${id}"].done`);
    }
    assert.equal(await bruno.locator('.waste-card.ok').count(), 2);
    assert.equal(await bruno.locator('.waste-card.bad').count(), 2);
    log('Bruno clasificó por arrastre: 2 correctas, 2 incorrectas');

    // Carla: una respuesta (táctil), recarga la página (reconexión) y continúa
    const carla = players[2].page;
    const [firstId, firstBin] = Object.entries(t1)[0];
    await carla.tap(`.waste-card[data-item="${firstId}"]`);
    await carla.tap(`.bins-dock [data-bin="${firstBin}"]`);
    await carla.waitForSelector(`.waste-card[data-item="${firstId}"].done`);
    await carla.reload();
    await carla.waitForSelector(`.waste-card[data-item="${firstId}"].done`, { timeout: 10000 });
    assert.equal(await carla.locator('.waste-card.done').count(), 1, 'tras reconectar conserva su respuesta');
    // El elemento ya respondido no puede volver a puntuar (lo valida el servidor).
    log('Carla se reconectó y conservó su respuesta');
    await host.screenshot({ path: join(SHOTS, '08-instructor-ronda-en-curso.png') });

    // Fin por tiempo (servidor) → resultados
    for (const pl of players) await pl.page.waitForSelector('text=Resultados de la ronda 1', { timeout: 40000 });
    await host.waitForSelector('text=Respuestas correctas · Ronda 1', { timeout: 15000 });
    await ana.screenshot({ path: join(SHOTS, '09-jugador-resultados-ronda.png'), fullPage: true });
    await host.screenshot({ path: join(SHOTS, '10-instructor-resultados-ronda.png') });
    log('La ronda se cerró por tiempo y se mostraron resultados');

    // ---------------- Ronda 2 y final ----------------
    await host.click('text=Iniciar ronda 2');
    await bruno.waitForSelector('.waste-card', { timeout: 15000 });
    await bruno.waitForSelector('.overlay', { state: 'hidden', timeout: 10000 });
    const t2 = await truth();
    const [id2, bin2] = Object.entries(t2)[0];
    await bruno.click(`.waste-card[data-item="${id2}"]`);
    await bruno.click(`.bins-dock [data-bin="${bin2}"]`);
    await bruno.waitForSelector(`.waste-card[data-item="${id2}"].ok`);
    await host.click('text=Finalizar partida');
    for (const pl of players) await pl.page.waitForSelector('text=/Partida finalizada|ganaste/', { timeout: 15000 });
    await ana.waitForSelector('text=¡Felicitaciones, ganaste!');
    await ana.screenshot({ path: join(SHOTS, '11-jugador-ganador.png'), fullPage: true });
    await host.waitForSelector('text=Ranking final');
    await host.screenshot({ path: join(SHOTS, '12-instructor-ranking-final.png'), fullPage: true });

    const ranking = await host.locator('.leaderboard-table tbody tr td:nth-child(2)').allInnerTexts();
    assert.deepEqual(ranking.slice(0, 3), ['Ana', 'Bruno', 'Carla']);
    log('Ranking final:', ranking.join(' > '));

    // CSV
    const [dl] = await Promise.all([host.waitForEvent('download'), host.click('text=Ranking (CSV)')]);
    const csv = readFileSync(await dl.path(), 'utf8');
    assert.ok(csv.startsWith('﻿Puesto;Alias;Puntaje'));
    assert.match(csv, /\r\n1;Ana;\d+;4;/);
    const [dl2] = await Promise.all([host.waitForEvent('download'), host.click('text=Detalle de respuestas (CSV)')]);
    const det = readFileSync(await dl2.path(), 'utf8').trim().split('\r\n');
    assert.equal(det.length, 1 + 4 + 4 + 1 + 1, 'cabecera + 10 respuestas');
    log('CSV de ranking y detalle exportados');

    // Historial
    await host.click('text=Historial');
    await host.waitForSelector(`td:has-text("${code}")`);
    assert.ok(await host.locator('td:has-text("Ana")').count());
    await host.screenshot({ path: join(SHOTS, '13-instructor-historial.png') });

    // Seguridad desde el navegador: el jugador no puede leer tablas.
    const leak = await ana.evaluate(async ({ url, key }) => {
      const r = await fetch(`${url}/rest/v1/round_items?select=correct_bin`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
      return r.status;
    }, { url: process.env.VITE_SUPABASE_URL, key: anonKey });
    assert.ok(leak === 401 || leak === 403, `acceso anónimo a round_items bloqueado (HTTP ${leak})`);
    log(`Lectura directa de respuestas correctas como anónimo: bloqueada (HTTP ${leak})`);

    assert.deepEqual(errors, [], 'sin errores de JavaScript en las páginas');
    console.log('\nE2E OK: todas las verificaciones pasaron. Capturas en', SHOTS);
  } finally {
    await browser.close();
    await new Promise((r) => web.httpServer.close(r));
    gateway.close();
    pgrst.kill();
    await db.end();
    await dropTestDb(DB);
  }
}

main().catch((e) => { console.error('\nE2E FALLÓ:', e); process.exit(1); });
