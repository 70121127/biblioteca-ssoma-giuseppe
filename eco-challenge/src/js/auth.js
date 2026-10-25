// Inicio de sesión del personal (instructor / administrador) con Supabase Auth.
import { supabase, rpc } from './supabase.js';
import { h, clear } from './ui.js';
import { friendlyError } from './errors.js';

export async function currentStaff() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  const role = await rpc('my_role');
  return { user: data.session.user, role };
}

export function renderLogin(container, { title, onLoggedIn }) {
  const msg = h('p', { class: 'form-error', role: 'alert' });
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', placeholder: 'correo@empresa.com' });
  const pass = h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password', placeholder: 'Contraseña' });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Ingresar');
  const form = h('form', { class: 'card login', onsubmit: async (ev) => {
    ev.preventDefault();
    btn.disabled = true;
    msg.textContent = '';
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (error) throw error;
      const staff = await currentStaff();
      if (!staff?.role) {
        await supabase.auth.signOut();
        throw new Error('Tu cuenta no tiene rol de instructor o administrador. Solicítalo al administrador.');
      }
      onLoggedIn(staff);
    } catch (err) {
      msg.textContent = friendlyError(err);
    } finally {
      btn.disabled = false;
    }
  } },
  h('h2', {}, title),
  h('label', {}, 'Correo', email),
  h('label', {}, 'Contraseña', pass),
  msg, btn,
  h('p', { class: 'muted small' }, 'Acceso sólo para personal autorizado. Las cuentas las crea el administrador.'));
  clear(container).append(form);
  email.focus();
}

export async function logout() {
  await supabase.auth.signOut();
  location.reload();
}
