# ♻️ SSOMA Eco Challenge

Juego multijugador tipo Kahoot para capacitaciones SSOMA: los participantes clasifican imágenes de residuos sólidos en el contenedor correcto según la **NTP 900.058:2019**, desde su celular, mientras el instructor proyecta la partida.

- **Participantes:** entran con un código de 6 dígitos (o QR) y un alias. No se piden datos personales.
- **Instructor:** crea la partida, elige el ámbito (**municipal** o **no municipal**), el banco de preguntas, la duración y la puntuación; inicia, pausa y finaliza rondas; ve el ranking y exporta CSV.
- **Administrador:** gestiona el banco de residuos (imágenes, contenedor, explicación) y **valida** cada registro antes de que pueda usarse.

| Pantalla | |
|---|---|
| Celular del participante | ![Jugador](docs/capturas/07-jugador-retroalimentacion.png) |
| Proyección del instructor | ![Instructor](docs/capturas/08-instructor-ronda-en-curso.png) |

Más capturas en [`docs/capturas/`](docs/capturas) (generadas por la prueba de extremo a extremo).

---

## 1. Estructura

```
eco-challenge/
├── index.html            Portada (Jugar / Instructor / Administración)
├── jugar.html            Pantalla del participante (celular)
├── instructor.html       Panel del instructor y pantalla de proyección
├── admin.html            Banco de residuos, bancos de preguntas, importación/exportación, personal
├── src/js/
│   ├── play.js           Lógica del participante (unión, tablero, reconexión, resultados)
│   ├── host.js           Panel del instructor (partida, QR, controles, ranking, CSV, historial)
│   ├── admin.js          Módulo administrativo
│   ├── dragdrop.js       Arrastrar y soltar (mouse/táctil) + selección por toque
│   ├── supabase.js       Cliente Supabase (sólo clave pública)
│   ├── realtime.js       Canal Realtime (avisos de refresco)
│   ├── clock.js          Reloj sincronizado con el servidor y cronómetro
│   ├── csv.js            CSV compatible con Excel (UTF-8 con BOM)
│   ├── validation.js     Validaciones compartidas
│   ├── errors.js, keys.js, ui.js, auth.js
├── src/css/              Estilos
├── public/
│   ├── img/residuos/     21 ilustraciones SVG propias (CC0) + LICENCIA.txt
│   └── _headers          Cabeceras de seguridad para Cloudflare Pages (CSP, etc.)
├── supabase/
│   ├── migrations/       001 esquema+RLS · 002 funciones de juego · 003 storage · 004 datos iniciales
│   └── setup_completo.sql  Las 4 migraciones en un solo archivo (para el SQL Editor)
├── tests/
│   ├── unit/             Pruebas de módulos JS
│   ├── sql/              Pruebas de seguridad y de juego sobre PostgreSQL
│   ├── load/             Carga 50/100/200 (local) y simulador contra Supabase real
│   └── e2e/              Prueba en navegador (Playwright) contra PostgREST local
└── scripts/bundle-sql.mjs
```

## 2. Cómo funciona (arquitectura)

```
 Celulares (50–200)          Proyector / instructor
   jugar.html                   instructor.html
       │  RPC (HTTPS)               │  RPC autenticadas (JWT del instructor)
       ▼                            ▼
 ┌───────────────────────── Supabase ─────────────────────────┐
 │ PostgreSQL + RLS: toda la lógica está en funciones SQL       │
 │   join_game · player_state · submit_answer (rol anon)        │
 │   create_game · start/pause/resume/end_round · finish_game … │
 │ Realtime (Broadcast): sólo "avisos" para refrescar el estado │
 │ Storage: bucket "residuos" (imágenes subidas por el personal)│
 └──────────────────────────────────────────────────────────────┘
```

- **El servidor manda.** El tiempo de cada ronda (`started_at`/`ends_at`), la validez de cada respuesta y el puntaje se calculan en PostgreSQL. El celular sólo muestra el cronómetro sincronizado con la hora del servidor.
- **Respuestas ocultas.** Mientras la ronda está abierta, el servidor envía los residuos **sin** su contenedor correcto (ni al jugador ni a la pantalla proyectada). Cada jugador recibe su propia retroalimentación como respuesta a su envío. Al cerrar la ronda se revelan a todos.
- **Realtime como aviso, no como verdad.** El instructor emite un aviso por el canal `eco-<código>` cuando cambia el estado; los celulares vuelven a pedir su estado al servidor (con un retardo aleatorio para no saturarlo). Un mensaje falso no puede cambiar nada. Si Realtime no está disponible, la app sigue funcionando por **sondeo periódico** (3–4 s durante la ronda).
- **Reconexión.** El participante guarda en su dispositivo un token de sesión aleatorio (el servidor sólo guarda su hash SHA-256). Si recarga la página o pierde la señal, recupera la partida, sus respuestas y su puntaje. Las respuestas hechas sin conexión quedan en cola y se reenvían; el servidor ignora duplicados.

### Mecánica y puntuación

| Regla | Implementación |
|---|---|
| Respuesta correcta | `puntos base` (100 por defecto, configurable) |
| Bono por rapidez | hasta `bono máx.` (50 por defecto, 0–50): `round(bono × (1 − tiempo_transcurrido / duración))` |
| Respuesta incorrecta | 0 puntos |
| Duplicados | restricción única (participante, ronda, residuo): sólo cuenta la **primera** respuesta |
| Cierre de ronda | el servidor rechaza respuestas después de `ends_at` (+1 s de margen por latencia) |
| Cuenta regresiva | 3 s de "¡Prepárate!" al iniciar cada ronda (compensa la latencia de red) |
| Pausa | congela el tiempo; el tiempo en pausa no cuenta para el bono |
| Desempate | 1) más aciertos, 2) menor tiempo acumulado en respuestas correctas |
| Ganador | puesto 1 al finalizar la partida (si persiste el empate se muestran todos) |

Retroalimentación configurable por partida: **inmediata** (el jugador ve ✅/❌, el contenedor correcto y la explicación) o **al final de la ronda** (sólo "respuesta registrada" hasta que cierra la ronda; evita que se "soplen" respuestas).

### Código de colores (NTP 900.058:2019)

| Municipal | No municipal |
|---|---|
| 🟩 Verde – Aprovechables | 🟦 Azul – Papel y cartón |
| 🟫 Marrón – Orgánicos | ⬜ Blanco – Plástico |
| ⬛ Negro – No aprovechables | 🟨 Amarillo – Metales |
| 🟥 Rojo – Peligrosos | ◽ Plomo – Vidrio |
| | 🟫 Marrón – Orgánicos |
| | 🟥 Rojo – Peligrosos |
| | ⬛ Negro – No aprovechables |

Cada banco de preguntas y cada partida pertenecen a **un solo ámbito**; la base de datos impide mezclarlos (triggers y validación en `create_game`). El ámbito es obligatorio al crear una partida.

## 3. Instalación de Supabase (paso a paso)

1. Cree un proyecto en <https://supabase.com> (región cercana, p. ej. São Paulo).
2. **SQL Editor → New query**: pegue el contenido completo de `supabase/setup_completo.sql` y ejecútelo.
   *(Alternativa con CLI: `supabase link --project-ref <ref>` y `supabase db push`, que aplica `supabase/migrations/`.)*
   El script es re-ejecutable.
3. **Authentication → Providers → Email**: deje habilitado el ingreso con correo y **desactive "Allow new users to sign up"** (las cuentas las crea el administrador).
4. **Authentication → Users → Add user**: cree su usuario (correo + contraseña, marcando *Auto Confirm User*).
5. Conviértase en administrador ejecutando en el SQL Editor (cambie el correo):
   ```sql
   insert into public.staff (user_id, role)
   select id, 'admin' from auth.users where email = 'su-correo@empresa.com'
   on conflict (user_id) do update set role = 'admin';
   ```
6. Los demás instructores: créelos en *Authentication → Users* y asígneles el rol desde **Banco de residuos → 👤 Personal** en la aplicación.
7. **Validar el banco:** los 37 ejemplos iniciales se crean como *pendientes*. Ingrese a `admin.html`, revíselos (vista previa) y apruébelos (botón *Seleccionar visibles* → *Aprobar seleccionados*). Sólo los residuos **aprobados y activos** aparecen en las partidas.
8. **Realtime:** no requiere configuración adicional (se usan canales *Broadcast* públicos). Si en *Realtime → Settings* activó "solo canales privados", desactívelo o la app usará sólo sondeo.

### Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `VITE_SUPABASE_URL` | Sí | *Project Settings → API → Project URL* |
| `VITE_SUPABASE_ANON_KEY` | Sí | Clave **pública**: `anon public` (JWT) o *Publishable key* (`sb_publishable_…`) |
| `VITE_PUBLIC_SITE_URL` | No | URL pública para el QR (p. ej. `https://eco.midominio.pe`). Por defecto, el dominio actual |

> ⚠️ **Nunca** use la clave `service_role` ni una *Secret key* (`sb_secret_…`). La aplicación se niega a arrancar si la detecta. La seguridad no depende de ocultar la clave pública: depende de RLS y de las funciones del servidor.

Para desarrollo local copie `.env.example` como `.env` y complete los valores. Si las variables faltan, la aplicación muestra "Configuración pendiente" (no simula ninguna conexión).

## 4. Publicación

### Opción actual: GitHub Pages (sin configuración adicional)

El repositorio ya publica la Biblioteca SSOMA con GitHub Pages desde la rama `main`. El juego compilado vive en la carpeta `eco/` de la raíz y queda disponible en:

**https://70121127.github.io/biblioteca-ssoma-giuseppe/eco/**

Para actualizarlo después de cambiar el código:

```bash
cd eco-challenge
npm run build:pages     # compila en ../eco usando .env.production
git add ../eco && git commit -m "Actualiza juego" && git push
```

`.env.production` contiene la URL y la clave **publishable** del proyecto Supabase `ssoma-eco-challenge` (valores públicos). GitHub Pages no aplica `public/_headers`; si necesita esas cabeceras de seguridad, use Cloudflare Pages.

### Alternativa: Cloudflare Pages

1. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** y elija este repositorio.
2. Configuración de compilación:
   - **Framework preset:** None (o Vite)
   - **Root directory:** `eco-challenge`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - Variable `NODE_VERSION` = `22`
3. **Environment variables** (Production y Preview): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` y, opcionalmente, `VITE_PUBLIC_SITE_URL`.
4. *Save and Deploy*. Cada push a la rama configurada vuelve a publicar.
5. `public/_headers` aplica CSP y otras cabeceras. Si usa un dominio personalizado para Supabase, añádalo a `connect-src`.

Alternativa por consola: `npm run build && npx wrangler pages deploy dist --project-name ssoma-eco-challenge` (con las variables definidas antes de compilar).

## 5. Uso en la capacitación

1. Instructor: `instructor.html` → **Nueva partida** → ámbito → banco → duración, residuos por ronda, rondas, puntos, bono y tipo de retroalimentación → **Crear partida**.
2. Proyecte la pantalla (botón **Pantalla completa**). Los participantes escanean el QR o entran a `/jugar.html` y escriben el código y su alias.
3. **Iniciar ronda** → los celulares muestran los residuos mezclados y los contenedores. Se clasifica **arrastrando** la imagen al contenedor, o **tocando** la imagen y luego el contenedor.
4. Al terminar el tiempo se bloquean las respuestas y se muestran las respuestas correctas, el % de aciertos por residuo y el ranking.
5. Tras la última ronda: **Finalizar partida** → podio y ganador → **Ranking (CSV)** / **Detalle de respuestas (CSV)** (elija separador `;` para Excel en español o `,`).
6. **Cerrar partida** cuando ya no se necesite: libera el código. El historial queda en **🗂️ Historial**.

Moderación: el instructor puede retirar a un participante con alias inapropiado (×); sus puntos no cuentan.

## 6. Seguridad y privacidad

- **RLS** activo en todas las tablas. El rol anónimo sólo puede leer la tabla de contenedores; todo lo demás pasa por funciones `SECURITY DEFINER` que validan cada dato.
- **Funciones del instructor** exigen sesión de Supabase Auth **y** registro en `staff`; un instructor sólo ve y controla sus partidas (el admin puede supervisar todas).
- **Sin escrituras directas** a partidas, rondas, participantes o respuestas: ni siquiera el instructor puede modificar un puntaje.
- **EXECUTE revocado** por defecto en todas las funciones; se concede explícitamente sólo lo necesario.
- **Validación por administrador:** un instructor puede proponer/editar residuos, pero cualquier cambio de clasificación vuelve el registro a *pendiente*; sólo un admin aprueba (trigger en la base de datos).
- **Imágenes:** URLs restringidas a rutas propias o `https://`; las externas exigen autor/licencia; subida sólo PNG/JPG/WEBP ≤ 2 MB por el personal (sin SVG subidos, que podrían contener scripts). Todo texto se inserta con `textContent` (sin `innerHTML`).
- **Datos personales mínimos:** sólo alias (2–20 caracteres). El token del participante se guarda hasheado y no es legible ni por el instructor.
- **CSV seguro:** se neutralizan celdas que empiezan por `= + - @` (inyección de fórmulas).

## 7. Pruebas

| Comando | Qué prueba | Requisitos |
|---|---|---|
| `npm run test:unit` | CSV, reloj/cronómetro, validaciones, rechazo de claves secretas | Node 20+ |
| `npm run test:sql` | 17 pruebas: RLS, permisos, validación por admin, ámbitos, flujo completo, duplicados, pausa, cierre por tiempo, desempates, expulsión, sala llena | PostgreSQL 16 local (`TEST_PG_URL`, por defecto `postgres://postgres:postgres@127.0.0.1:5432/postgres`) |
| `npm run test:load:db` | 50, 100 y 200 participantes simultáneos: unión, respuestas, duplicados, integridad del ranking | PostgreSQL local |
| `npm run test:e2e` | Navegador real: admin valida y crea un residuo, instructor crea partida, 3 celulares juegan (toque, arrastre, recarga/reconexión), cierre por tiempo, ranking, CSV, historial | PostgreSQL + `POSTGREST_BIN` |
| `npm run test:load:supabase -- <código> 200 --realtime` | Bots contra **su proyecto Supabase real** | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, una partida creada |

Las pruebas SQL/E2E usan un *stub* mínimo de los esquemas `auth` y `storage` de Supabase (`tests/sql/supabase-stub.sql`) y PostgREST, el mismo servidor REST que usa Supabase. **No sustituyen** una prueba en el proyecto real: Realtime y Storage no se ejercitan localmente.

### Resultados obtenidos en el entorno de desarrollo (PostgreSQL 16 local, pool de 20 conexiones)

- Unitarias: 7/7 ✅ · SQL: 17/17 ✅ · E2E en Chromium: ✅ (todas las verificaciones).
- Carga (8 residuos por ronda, 1 de cada 5 jugadores reintenta respuestas duplicadas):

| Participantes | Respuestas | Duplicados rechazados | `submit_answer` p95 | `player_state` p95 | `join_game` p95 |
|---|---|---|---|---|---|
| 50 | 400 | 80 | 3,3 ms | 49 ms | 141 ms |
| 100 | 800 | 160 | 3,2 ms | 63 ms | 93 ms |
| 200 | 1600 | 320 | 3,0 ms | 115 ms | 181 ms |

**En el proyecto Supabase real `ssoma-eco-challenge`** (25/10/2026, prueba ejecutada dentro de la base de datos y deshecha al final; sin red ni Realtime):

| Participantes | Respuestas registradas | Duplicados rechazados | Ranking correcto | ms por respuesta | ms `player_state` | ms panel instructor |
|---|---|---|---|---|---|---|
| 50 | 400/400 | 80 | ✅ | 0,26 | 1,20 | 4,0 |
| 100 | 800/800 | 160 | ✅ | 0,23 | 1,17 | 4,4 |
| 200 | 1600/1600 | 320 | ✅ | 0,23 | 1,59 | 7,6 |

Son tiempos de base de datos sin la latencia de Internet. **Pendiente:** ejecutar `test:load:supabase` con 50, 100 y 200 bots contra el proyecto real antes de la primera capacitación masiva.

### Límites del plan de Supabase a tener en cuenta

- **Realtime – plan Free: 200 conexiones simultáneas** (Pro: 500). Con 200 participantes + instructor se supera el límite del plan Free: los que no consigan conexión Realtime siguen jugando por sondeo (3–4 s de retraso en ver el inicio de la ronda). Para 200 participantes se recomienda el plan **Pro**.
- Con 200 jugadores el sondeo genera ≈ 60–70 peticiones/s durante una ronda (funciones livianas, medidas arriba).
- Verifique los límites vigentes en la documentación de Supabase, pueden cambiar.

## 8. Etapas del proyecto

| Etapa | Estado |
|---|---|
| 1. Prototipo visual | ✅ Portada, jugador, instructor, admin (responsive) |
| 2. Banco de imágenes y contenedores | ✅ 11 contenedores NTP, 37 ejemplos con 21 ilustraciones propias, CRUD con vista previa, validación, importación/exportación JSON/CSV |
| 3. Base de datos y permisos | ✅ Esquema, RLS, funciones, storage (probado en PostgreSQL local) |
| 4. Partidas en tiempo real | ✅ Lógica y sondeo probados E2E · ⏳ Realtime Broadcast por probar en Supabase real |
| 5. Puntuación y ranking | ✅ Probado (bono, duplicados, desempates, pausa) |
| 6. Pruebas 50/100/200 | ✅ Base de datos local · ⏳ contra Supabase real (script incluido) |
| 7. Publicación en Cloudflare Pages | ⏳ Instrucciones listas; requiere su cuenta y su proyecto Supabase |

## 9. Desarrollo local

```bash
cd eco-challenge
npm install
cp .env.example .env        # complete con su proyecto Supabase
npm run dev                 # http://localhost:5173
```

Para probar desde celulares en la misma red: `npm run dev -- --host` y abra `http://<IP-de-su-PC>:5173/jugar.html`.

## 10. Licencias

- Código: del propietario del repositorio.
- Ilustraciones `public/img/residuos/*.svg` y `public/img/logo.svg`: creadas para este proyecto, CC0 (ver `LICENCIA.txt`). No se usan imágenes de terceros. Si agrega fotos externas, registre autor y licencia en el campo correspondiente.
- Los residuos peligrosos se muestran sólo con fines educativos; sus explicaciones indican no manipularlos sin EPP ni procedimiento.
