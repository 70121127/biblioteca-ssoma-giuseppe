-- =====================================================================
-- SSOMA ECO CHALLENGE · 004 · Datos iniciales
-- Contenedores NTP 900.058:2019 y ejemplos ilustrativos del banco.
-- Las imágenes de ejemplo son ilustraciones SVG propias del proyecto
-- (carpeta public/img/residuos, licencia CC0).
-- Los ejemplos se crean como "pendiente": un administrador debe validarlos
-- en el módulo administrativo antes de usarlos en una partida.
-- =====================================================================

insert into public.bins (scope, code, color_name, label, color_hex, text_hex, icon, description, sort_order) values
  ('municipal', 'verde',  'Verde',  'Aprovechables',    '#2E9E44', '#FFFFFF', '♻️',
   'Papel, cartón, plásticos, metales, vidrio y otros residuos que pueden reciclarse.', 1),
  ('municipal', 'marron', 'Marrón', 'Orgánicos',        '#7B4A2A', '#FFFFFF', '🍂',
   'Restos de alimentos, cáscaras, restos de poda y otros residuos biodegradables.', 2),
  ('municipal', 'negro',  'Negro',  'No aprovechables', '#1F1F1F', '#FFFFFF', '🗑️',
   'Residuos que no pueden reciclarse: papel higiénico, envolturas metalizadas, tecnopor sucio.', 3),
  ('municipal', 'rojo',   'Rojo',   'Peligrosos',       '#D32F2F', '#FFFFFF', '☣️',
   'Pilas, focos, envases de productos químicos y otros residuos peligrosos.', 4),

  ('no_municipal', 'azul',     'Azul',     'Papel y cartón',   '#1E63C6', '#FFFFFF', '📦',
   'Papel, cartón, periódicos y revistas limpios y secos.', 1),
  ('no_municipal', 'blanco',   'Blanco',   'Plástico',         '#FFFFFF', '#1D2630', '🧴',
   'Botellas, envases y otros plásticos limpios.', 2),
  ('no_municipal', 'amarillo', 'Amarillo', 'Metales',          '#F2C200', '#1D2630', '🥫',
   'Latas, chatarra menor y otros metales.', 3),
  ('no_municipal', 'plomo',    'Plomo',    'Vidrio',           '#8A8F96', '#FFFFFF', '🍾',
   'Botellas y frascos de vidrio.', 4),
  ('no_municipal', 'marron',   'Marrón',   'Orgánicos',        '#7B4A2A', '#FFFFFF', '🍂',
   'Restos de alimentos y otros residuos biodegradables.', 5),
  ('no_municipal', 'rojo',     'Rojo',     'Peligrosos',       '#D32F2F', '#FFFFFF', '☣️',
   'Residuos con características de peligrosidad: pilas, trapos con hidrocarburos, envases de químicos.', 6),
  ('no_municipal', 'negro',    'Negro',    'No aprovechables', '#1F1F1F', '#FFFFFF', '🗑️',
   'Residuos generales que no pueden reciclarse.', 7)
on conflict (scope, code) do update set
  color_name = excluded.color_name, label = excluded.label, color_hex = excluded.color_hex,
  text_hex = excluded.text_hex, icon = excluded.icon, description = excluded.description,
  sort_order = excluded.sort_order;

-- Ejemplos ilustrativos (identificador fijo para poder re-ejecutar el script).
insert into public.waste_items (id, name, scope, bin_code, image_url, image_source, image_credit, explanation) values
  -- Ámbito municipal
  ('a0000000-0000-4000-8000-000000000001', 'Hoja de papel', 'municipal', 'verde', '/img/residuos/papel.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel limpio y seco es aprovechable: se recicla para fabricar papel nuevo.'),
  ('a0000000-0000-4000-8000-000000000002', 'Caja de cartón', 'municipal', 'verde', '/img/residuos/carton.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El cartón es aprovechable. Pliégalo para ocupar menos espacio y mantenlo seco.'),
  ('a0000000-0000-4000-8000-000000000003', 'Periódico', 'municipal', 'verde', '/img/residuos/periodico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Periódicos y revistas son aprovechables si están limpios y secos.'),
  ('a0000000-0000-4000-8000-000000000004', 'Botella de plástico PET', 'municipal', 'verde', '/img/residuos/botella-pet.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las botellas PET son aprovechables. Vacíalas y aplástalas antes de depositarlas.'),
  ('a0000000-0000-4000-8000-000000000005', 'Lata de aluminio', 'municipal', 'verde', '/img/residuos/lata.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las latas de metal son aprovechables y pueden reciclarse indefinidamente.'),
  ('a0000000-0000-4000-8000-000000000006', 'Botella de vidrio', 'municipal', 'verde', '/img/residuos/botella-vidrio.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'En el ámbito municipal el vidrio va con los aprovechables (contenedor verde).'),
  ('a0000000-0000-4000-8000-000000000007', 'Cáscara de plátano', 'municipal', 'marron', '/img/residuos/cascara-platano.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las cáscaras de frutas son residuos orgánicos: pueden convertirse en compost.'),
  ('a0000000-0000-4000-8000-000000000008', 'Restos de manzana', 'municipal', 'marron', '/img/residuos/manzana.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de frutas y verduras son orgánicos y biodegradables.'),
  ('a0000000-0000-4000-8000-000000000009', 'Restos de comida', 'municipal', 'marron', '/img/residuos/restos-comida.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de alimentos van al contenedor de orgánicos, sin envases ni cubiertos.'),
  ('a0000000-0000-4000-8000-000000000010', 'Cáscaras de huevo', 'municipal', 'marron', '/img/residuos/cascara-huevo.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las cáscaras de huevo son orgánicas y aportan calcio al compost.'),
  ('a0000000-0000-4000-8000-000000000011', 'Papel higiénico usado', 'municipal', 'negro', '/img/residuos/papel-higienico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel higiénico usado no es aprovechable: está contaminado y no se recicla.'),
  ('a0000000-0000-4000-8000-000000000012', 'Envoltura metalizada de snack', 'municipal', 'negro', '/img/residuos/envoltura.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las envolturas multicapa (plástico + aluminio) no son aprovechables en la mayoría de sistemas.'),
  ('a0000000-0000-4000-8000-000000000013', 'Servilleta sucia', 'municipal', 'negro', '/img/residuos/servilleta.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel con grasa o restos de comida pierde su valor de reciclaje: es no aprovechable.'),
  ('a0000000-0000-4000-8000-000000000014', 'Tecnopor con restos de comida', 'municipal', 'negro', '/img/residuos/tecnopor.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El tecnopor sucio no es aprovechable. Prefiere envases reutilizables.'),
  ('a0000000-0000-4000-8000-000000000015', 'Pilas usadas', 'municipal', 'rojo', '/img/residuos/pila.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las pilas contienen metales pesados: son residuos peligrosos. No las abras ni manipules; entrégalas en un punto de acopio autorizado.'),
  ('a0000000-0000-4000-8000-000000000016', 'Fluorescente o foco ahorrador', 'municipal', 'rojo', '/img/residuos/fluorescente.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los fluorescentes contienen mercurio: son peligrosos. No los rompas; entrégalos completos al personal responsable.'),
  ('a0000000-0000-4000-8000-000000000017', 'Aerosol o envase de pintura', 'municipal', 'rojo', '/img/residuos/aerosol.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los envases de productos químicos son peligrosos. No los perfores ni quemes; sepáralos para su gestión especial.'),

  -- Ámbito no municipal
  ('b0000000-0000-4000-8000-000000000001', 'Hoja de papel', 'no_municipal', 'azul', '/img/residuos/papel.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel limpio y seco va al contenedor azul de papel y cartón.'),
  ('b0000000-0000-4000-8000-000000000002', 'Caja de cartón', 'no_municipal', 'azul', '/img/residuos/carton.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El cartón va al contenedor azul. Pliégalo y mantenlo seco.'),
  ('b0000000-0000-4000-8000-000000000003', 'Periódico', 'no_municipal', 'azul', '/img/residuos/periodico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Periódicos y revistas van al contenedor azul de papel y cartón.'),
  ('b0000000-0000-4000-8000-000000000004', 'Botella de plástico PET', 'no_municipal', 'blanco', '/img/residuos/botella-pet.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las botellas de plástico van al contenedor blanco. Vacíalas y aplástalas.'),
  ('b0000000-0000-4000-8000-000000000005', 'Envase de plástico', 'no_municipal', 'blanco', '/img/residuos/envase-plastico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los envases plásticos limpios (que no contuvieron sustancias peligrosas) van al contenedor blanco.'),
  ('b0000000-0000-4000-8000-000000000006', 'Lata de aluminio', 'no_municipal', 'amarillo', '/img/residuos/lata.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las latas y otros metales van al contenedor amarillo.'),
  ('b0000000-0000-4000-8000-000000000007', 'Retazos metálicos y clavos', 'no_municipal', 'amarillo', '/img/residuos/clavos.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'La chatarra menor va al contenedor amarillo de metales. Manipúlala con guantes por riesgo de cortes.'),
  ('b0000000-0000-4000-8000-000000000008', 'Botella de vidrio', 'no_municipal', 'plomo', '/img/residuos/botella-vidrio.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'En el ámbito no municipal el vidrio va al contenedor plomo.'),
  ('b0000000-0000-4000-8000-000000000009', 'Frasco de vidrio', 'no_municipal', 'plomo', '/img/residuos/frasco-vidrio.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los frascos de vidrio limpios van al contenedor plomo.'),
  ('b0000000-0000-4000-8000-000000000010', 'Cáscara de plátano', 'no_municipal', 'marron', '/img/residuos/cascara-platano.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las cáscaras de frutas van al contenedor marrón de orgánicos.'),
  ('b0000000-0000-4000-8000-000000000011', 'Restos de comida', 'no_municipal', 'marron', '/img/residuos/restos-comida.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de alimentos del comedor van al contenedor marrón.'),
  ('b0000000-0000-4000-8000-000000000012', 'Restos de manzana', 'no_municipal', 'marron', '/img/residuos/manzana.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de frutas son orgánicos: contenedor marrón.'),
  ('b0000000-0000-4000-8000-000000000013', 'Pilas usadas', 'no_municipal', 'rojo', '/img/residuos/pila.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las pilas son residuos peligrosos (contenedor rojo). No las abras; entrégalas al almacén de residuos peligrosos.'),
  ('b0000000-0000-4000-8000-000000000014', 'Fluorescente o foco ahorrador', 'no_municipal', 'rojo', '/img/residuos/fluorescente.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los fluorescentes contienen mercurio: contenedor rojo. No los rompas; entrégalos completos.'),
  ('b0000000-0000-4000-8000-000000000015', 'Trapo con aceite o hidrocarburo', 'no_municipal', 'rojo', '/img/residuos/trapo-aceite.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los materiales impregnados con hidrocarburos son peligrosos (contenedor rojo). Manipúlalos sólo con EPP y según el procedimiento.'),
  ('b0000000-0000-4000-8000-000000000016', 'Aerosol o envase de pintura', 'no_municipal', 'rojo', '/img/residuos/aerosol.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los envases de químicos son peligrosos (contenedor rojo). No los perfores ni reutilices.'),
  ('b0000000-0000-4000-8000-000000000017', 'Papel higiénico usado', 'no_municipal', 'negro', '/img/residuos/papel-higienico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel higiénico usado va al contenedor negro de no aprovechables.'),
  ('b0000000-0000-4000-8000-000000000018', 'Envoltura metalizada de snack', 'no_municipal', 'negro', '/img/residuos/envoltura.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las envolturas multicapa van al contenedor negro de no aprovechables.'),
  ('b0000000-0000-4000-8000-000000000019', 'Tecnopor con restos de comida', 'no_municipal', 'negro', '/img/residuos/tecnopor.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El tecnopor sucio va al contenedor negro de no aprovechables.'),
  ('b0000000-0000-4000-8000-000000000020', 'Servilleta sucia', 'no_municipal', 'negro', '/img/residuos/servilleta.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel con grasa o comida no se recicla: contenedor negro.')
on conflict (id) do nothing;

-- Bancos de preguntas base, uno por ámbito.
insert into public.question_banks (id, name, scope, description, owner_id) values
  ('c0000000-0000-4000-8000-000000000001', 'Básico · Ámbito municipal', 'municipal',
   'Residuos domiciliarios y de oficina. Contenedores verde, marrón, negro y rojo.', null),
  ('c0000000-0000-4000-8000-000000000002', 'Básico · Ámbito no municipal', 'no_municipal',
   'Residuos de actividades productivas (obra, planta, campamento). Siete colores.', null)
on conflict (id) do nothing;

insert into public.bank_items (bank_id, item_id)
select 'c0000000-0000-4000-8000-000000000001', id from public.waste_items
 where id::text like 'a0000000-%'
on conflict do nothing;

insert into public.bank_items (bank_id, item_id)
select 'c0000000-0000-4000-8000-000000000002', id from public.waste_items
 where id::text like 'b0000000-%'
on conflict do nothing;
