// SÓLO PARA PRUEBAS LOCALES. Pasarela mínima que expone PostgREST (el mismo
// servidor REST que usa Supabase) bajo las rutas /rest/v1 y emite JWT de
// prueba en /auth/v1/token para cuentas de prueba fijas. No reemplaza a
// Supabase: no hay Realtime ni Storage, y la app recurre al sondeo periódico.
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function signJwt(payload, secret) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-client-info, x-supabase-api-version',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, content-location',
};

/**
 * @param {{port:number, postgrestPort:number, secret:string, users: Record<string,{id:string,password:string}>}} opts
 */
export function startGateway({ port, postgrestPort, secret, users }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    if (url.pathname.startsWith('/rest/v1/')) {
      const headers = { ...req.headers, host: `127.0.0.1:${postgrestPort}` };
      delete headers.apikey;
      const up = http.request({ host: '127.0.0.1', port: postgrestPort, method: req.method,
        path: url.pathname.slice('/rest/v1'.length) + url.search, headers }, (r) => {
        res.writeHead(r.statusCode, { ...r.headers, ...CORS });
        r.pipe(res);
      });
      up.on('error', () => { res.writeHead(502, CORS); res.end('{"message":"postgrest no disponible"}'); });
      req.pipe(up);
      return;
    }

    if (url.pathname === '/auth/v1/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { email, password } = JSON.parse(body || '{}');
        const u = users[email];
        if (!u || u.password !== password) {
          res.writeHead(400, { ...CORS, 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const user = { id: u.id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
        const access = signJwt({ sub: u.id, role: 'authenticated', aud: 'authenticated', email, iat: now, exp: now + 3600 }, secret);
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: randomUUID(), user }));
      });
      return;
    }

    if (url.pathname === '/auth/v1/user') {
      const claims = decodeJwt(String(req.headers.authorization || '').replace(/^Bearer /i, ''));
      res.writeHead(claims?.sub ? 200 : 401, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify(claims?.sub ? { id: claims.sub, email: claims.email, aud: 'authenticated', role: 'authenticated' } : { msg: 'no session' }));
      return;
    }

    if (url.pathname === '/auth/v1/logout') { res.writeHead(204, CORS); res.end(); return; }

    res.writeHead(404, { ...CORS, 'content-type': 'application/json' });
    res.end('{"message":"no disponible en la pasarela de pruebas"}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
