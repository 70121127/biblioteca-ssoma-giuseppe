// Utilidades para probar las migraciones contra un PostgreSQL LOCAL.
// Simula cómo Supabase/PostgREST ejecuta cada petición: una transacción con
// `set local role` (anon/authenticated) y los claims del JWT en
// `request.jwt.claims`. No sustituye una prueba contra Supabase real.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..');
const ADMIN_URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export function migrationFiles() {
  const dir = join(root, 'supabase', 'migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f));
}

export async function createTestDb(name) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  await setup.query('set client_min_messages = warning');
  for (const f of [join(here, 'supabase-stub.sql'), ...migrationFiles()]) {
    await setup.query(readFileSync(f, 'utf8'));
  }
  await setup.end();
  return url;
}

export async function dropTestDb(name) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
}

/** Ejecuta una consulta como lo haría PostgREST para un rol y usuario dados. */
export async function asRole(pool, { role = 'anon', uid = null } = {}, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role === 'authenticated' ? 'authenticated' : 'anon'}`);
    const claims = uid ? { sub: uid, role } : { role };
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const res = await client.query(sql, params);
    await client.query('commit');
    return res;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const anon = (pool, sql, params) => asRole(pool, { role: 'anon' }, sql, params);
export const user = (pool, uid, sql, params) => asRole(pool, { role: 'authenticated', uid }, sql, params);

/** Llama a una función RPC y devuelve el primer valor de la primera fila. */
export async function rpc(pool, who, fn, args = []) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const res = await asRole(pool, who, `select to_json(public.${fn}(${ph})) as r`, args);
  return res.rows[0].r;
}

export async function createUser(pool, email, role) {
  const { rows } = await pool.query('insert into auth.users (email) values ($1) returning id', [email]);
  const id = rows[0].id;
  if (role) await pool.query('insert into public.staff (user_id, role) values ($1, $2)', [id, role]);
  return id;
}

/** Aprueba todos los ejemplos del banco como lo haría un administrador. */
export async function approveAll(pool, adminId) {
  await user(pool, adminId, `update public.waste_items set status = 'aprobado' where status <> 'aprobado'`);
}
