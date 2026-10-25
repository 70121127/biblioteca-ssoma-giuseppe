// Cliente único de Supabase. Sólo usa la clave PÚBLICA; si falta la
// configuración la app lo indica en pantalla (no se simula ninguna conexión).
import { createClient } from '@supabase/supabase-js';
import { checkSupabaseConfig } from './keys.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configError = checkSupabaseConfig(url, key);

export const supabase = configError
  ? null
  : createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 10 } },
    });

export const publicSiteUrl = (import.meta.env.VITE_PUBLIC_SITE_URL || '').replace(/\/$/, '');

/** Llama a una función RPC y lanza un Error con el mensaje del servidor. */
export async function rpc(fn, args = {}) {
  if (!supabase) throw new Error(configError);
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const e = new Error(error.message || 'Error');
    e.details = error;
    throw e;
  }
  return data;
}

/** Devuelve la respuesta de una RPC y las marcas de tiempo locales (para sincronizar el reloj). */
export async function timedRpc(fn, args = {}) {
  const sentAt = Date.now();
  const data = await rpc(fn, args);
  return { data, sentAt, receivedAt: Date.now() };
}
