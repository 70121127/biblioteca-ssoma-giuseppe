// Une las migraciones en un único archivo para pegar en el SQL Editor de Supabase.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const out = ['-- SSOMA ECO CHALLENGE · instalación completa (generado por `npm run sql:bundle`).',
  '-- Pegue TODO este archivo en Supabase > SQL Editor y ejecútelo una vez.', ''];
for (const f of files) out.push(`-- >>>>>>>>>> ${f}`, readFileSync(join(dir, f), 'utf8'), '');
writeFileSync(join(root, 'supabase', 'setup_completo.sql'), out.join('\n'));
console.log(`supabase/setup_completo.sql generado con ${files.length} migraciones`);
