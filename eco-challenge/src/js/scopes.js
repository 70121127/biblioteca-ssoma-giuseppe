// Carga los ámbitos configurados (tabla pública "scopes") en el registro de la interfaz.
import { supabase } from './supabase.js';
import { setScopes, getScopes } from './ui.js';

export async function loadScopes() {
  if (!supabase) return getScopes();
  const { data, error } = await supabase.from('scopes').select('code, theme, name, description, prompt, sort_order').order('sort_order');
  if (!error) setScopes(data);
  return getScopes();
}
