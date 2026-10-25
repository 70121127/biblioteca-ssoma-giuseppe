// Validación de la clave pública de Supabase (sin dependencias del navegador).

function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function'
      ? atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))
      : Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Devuelve null si la configuración es válida, o un mensaje de error.
 * Rechaza claves secretas (service_role / sb_secret_) para que nunca
 * terminen publicadas en el navegador.
 */
export function checkSupabaseConfig(url, key) {
  if (!url || !key) {
    return 'Supabase no está configurado: defina VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (ver README).';
  }
  if (!/^https?:\/\/[^\s]+$/.test(url)) return 'VITE_SUPABASE_URL no es una URL válida.';
  if (/^sb_secret_/.test(key)) {
    return 'Se configuró una clave SECRETA de Supabase. Use la clave pública (anon / publishable).';
  }
  if (/^sb_publishable_/.test(key)) return null;
  const payload = decodeJwtPayload(key);
  if (!payload) return 'VITE_SUPABASE_ANON_KEY no tiene un formato reconocido.';
  if (payload.role === 'service_role') {
    return 'Se configuró la clave service_role. Use la clave pública "anon".';
  }
  return null;
}
