# ApiDental: sistema de diseño (v0.1, propuesta)

Documento previo a construir el frontend (`apps/admin`, React + Vite, bajo `/admin`) y el sitio comercial (`apps/web`, Next.js). **No hay código de interfaz todavía.**

Archivos asociados (generados por `node docs/diseno/tools/build.mjs`, que también valida el contraste y falla si algún par deja de cumplir):

- [`tokens.json`](tokens.json) y [`tokens.css`](tokens.css): fuente de tokens para el frontend.
- [`vista-previa.html`](vista-previa.html): página estática autocontenida con la paleta, tipografía, componentes y una composición del panel. Se abre con doble clic.

Convención: lo marcado **[por validar]** es una decisión provisional o depende de normativa, de Apiworking o de revisión profesional.

---

## 0. Principios y límites

### 0.1 Prioridades (en este orden)

1. **Velocidad:** las tareas diarias (buscar un paciente, dar una cita, cobrar) en pocos pasos y con teclado.
2. **Legibilidad:** texto grande, contraste alto, datos clave siempre visibles.
3. **Baja carga cognitiva:** una acción principal por pantalla, vocabulario del consultorio, nada que distraiga.
4. **Efectos visuales:** solo si no estorban a lo anterior. Sin animaciones decorativas, sin degradados en el panel.

### 0.2 Qué se toma de la referencia y qué no

Doctocliq se usó solo como **inspiración de enfoque**: claridad, espacios amplios, tarjetas ligeras, iconografía simple, jerarquía fuerte y un mensaje comercial orientado a beneficios. La referencia no expone una paleta que pueda medirse, así que **ningún valor de este sistema deriva de ella**: colores, tipografías, nombres, composición, iconos, textos y marca son propios de ApiDental/Apiworking.

Reglas de originalidad (obligatorias para quien diseñe o construya):

- No copiar ni recrear logos, textos, imágenes, ilustraciones, capturas, nombres de módulos, estructura exacta ni código de Doctocliq ni de otro competidor.
- No usar su nombre en la interfaz, el sitio, los metadatos ni el SEO, y no presentar ApiDental como afiliado, compatible o relacionado con ellos.
- Las capturas del producto en el sitio serán del propio panel, con datos ficticios.
- Fuentes e iconos solo con licencia abierta verificada (ver 3 y 5.9). Ilustraciones y fotos: propias o con licencia comprada/permiso por escrito.
- Antes de publicar: revisión de originalidad (este punto está en la lista de aceptación, sección 13).

### 0.3 Diferencia funcional que el diseño debe comunicar

ApiDental se integra **de forma nativa con Apiworking**: facturación electrónica, fidelización (APILoyalty) y métricas de ApiReview/NFC. En la interfaz esto se traduce en:

- Estados de sincronización claros y honestos ("Cobro guardado · Comprobante pendiente de envío"); un corte externo nunca hace perder un cobro.
- Una pantalla de conciliación sencilla para lo pendiente o rechazado.
- Insignia sobria "Apiworking" solo donde un dato proviene de allí.
- Honestidad de hoja de ruta: la fidelización (P1) y ApiReview (P2) se muestran como "próximamente" hasta que existan.

---

## 1. Identidad propia

| Elemento | Decisión (provisional) |
|---|---|
| Nombre | **ApiDental** (producto) · "by Apiworking" como respaldo de la marca madre, en tamaño secundario. |
| Concepto | Un diente simple y redondeado sobre un cuadrado de esquinas suaves, con un pequeño punto ámbar ("chispa") que alude a lo conectado/inteligente sin ser un cliché. Reconocible a 16 px. |
| Marca | Versión provisional en `vista-previa.html` (SVG). **Debe ser refinada o sustituida por un diseñador** [por validar]; hay que registrarla antes de lanzar. |
| Uso | Ícono solo (app, favicon, barra lateral) y versión horizontal (sitio). Margen mínimo = ¼ del alto. Fondo claro u oscuro de la paleta; nunca sobre fotos sin velo. |
| Voz | Español neutro peruano, trato de **usted**, frases cortas, verbos de acción ("Cobrar", "Reprogramar"). Sin jerga técnica ("sincronizar" sí; "outbox" no). Mensajes de error que dicen qué pasó y qué hacer. |
| Nombres de módulos | Hoy · Agenda · Pacientes · Caja · Comprobantes · Inventario · Reportes · Configuración. Nombres propios y descriptivos; no se imitan los de otros productos. |
| Formatos | Fecha `dd/mm/aaaa` (completa: "mar 14 oct 2026"), hora 24 h, moneda `S/ 1,234.50`, teléfono `900 000 001`, DNI sin separadores. Zona horaria America/Lima. |

---

## 2. Paleta propia

Concepto: **"Laguna"**, un azul-verdoso sereno (clínico, confiable, fresco) sobre neutros fríos muy claros; **"Ámbar"** como único acento cálido. Sin degradados.

### 2.1 Primitivos

| Grupo | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 |
|---|---|---|---|---|---|---|---|---|---|---|
| **Laguna (marca)** | `#ECFAFB` | `#D3F1F4` | `#A6E2E9` | `#6FCBD7` | `#37B0C0` | `#1796A8` | `#0F7889` | `#0D6070` | `#104E5B` | `#123F4A` |
| **Ámbar (acento)** | `#FFF8EA` | `#FDEBC8` | — | `#F6C566` | — | `#EE9F1F` | — | `#8F5A06` | `#6F4504` | — |

Pizarra (neutros): `0 #FFFFFF` · `25 #F7F9FA` · `50 #EFF3F5` · `100 #E3E9ED` · `200 #CFD8DE` · `300 #AFBDC6` · `400 #8696A3` · `500 #5F7280` · `600 #475965` · `700 #344550` · `800 #222F39` · `900 #141E26`.

Semánticos (fondo 50 / base 500 / texto 700): **Éxito** `#E8F6EE · #1E8A4C · #14633A` · **Advertencia** `#FFF4DB · #C27803 · #7A4B00` · **Peligro** `#FDECEA · #CC3B32 · #992820` · **Información** `#E8F1FB · #2B6CB0 · #1E4E85`.

### 2.2 Reglas de uso

- **Proporción:** ~90 % neutros, ~8 % Laguna (acciones, selección, enlaces), ~2 % estados y Ámbar. Una sola acción primaria (Laguna 600) por vista.
- **Ámbar** solo para fidelización, puntos y destacados comerciales. **Nunca** para errores, estados clínicos ni advertencias (para eso existe "Advertencia").
- **Rojo** solo para error, peligro, ausencia y patología. No decorar con rojo.
- **El color nunca es el único canal:** todo estado lleva icono + texto (ver 5.4).
- **Daltonismo:** las combinaciones críticas (rojo/azul del odontograma, éxito/peligro) se distinguen además por símbolo y etiqueta.
- **Modo oscuro:** fuera de P0. Los tokens semánticos (`--bg-surface`, `--text-default`…) permiten añadirlo después sin tocar componentes.

### 2.3 Contraste verificado (WCAG 2.2 AA)

Calculado por script con 27 combinaciones; todas cumplen. Resumen de las críticas:

| Combinación | Ratio | Mínimo |
|---|---|---|
| Texto principal `#141E26` sobre fondo `#F7F9FA` | 15.99 : 1 | 7 |
| Texto secundario `#475965` sobre blanco | 7.28 : 1 | 4.5 |
| Texto de apoyo/placeholder `#5F7280` sobre blanco | 4.99 : 1 | 4.5 |
| Botón primario: blanco sobre `#0F7889` | 5.16 : 1 | 4.5 |
| Botón peligro: blanco sobre `#CC3B32` | 4.95 : 1 | 4.5 |
| Enlace `#0D6070` sobre blanco | 7.18 : 1 | 4.5 |
| Insignias (texto 700/800 sobre fondo 50/100) | 6.55 a 8.90 : 1 | 4.5 |
| Borde de campo `#8696A3` sobre blanco | 3.04 : 1 | 3 (componente de interfaz) |
| Iconos de estado sobre blanco | 3.51 a 5.42 : 1 | 3 |
| Texto sobre barra lateral `#141E26` | 16.89 : 1 | 7 |

Regla derivada: el texto esencial **no** usa `neutral-400` ni más claro; `neutral-500` solo para apoyo y placeholders.

---

## 3. Tipografía

| Uso | Familia | Licencia | Notas |
|---|---|---|---|
| Interfaz y lectura | **Inter** (variable) | SIL OFL | Excelente en tamaños pequeños, números tabulares (`font-variant-numeric: tabular-nums` para importes y horas), cubre tildes y ñ. |
| Títulos y sitio comercial | **Manrope** | SIL OFL | Algo más cálida; se usa solo en títulos y cifras destacadas. |
| Códigos, IDs | JetBrains Mono | SIL OFL | Uso mínimo (identificadores, hashes visibles solo para administración). |

- **Autoalojadas** (subconjunto latino, `font-display: swap`, solo pesos 400/500/600/700/800): evita solicitudes a terceros desde una aplicación con datos de pacientes y mejora el rendimiento. Pila de respaldo: `system-ui, -apple-system, 'Segoe UI', Roboto, Arial`.
- **Escala** (base del panel 15 px; el sitio comercial usa 16 px):

| Token | Tamaño / interlínea / peso | Uso |
|---|---|---|
| `display` | 48 px / 1.1 / 800 | Hero del sitio comercial |
| `h1` | 28 px / 1.25 / 700 | Título de pantalla |
| `h2` | 22 px / 1.3 / 700 | Sección |
| `h3` | 18 px / 1.35 / 600 | Título de tarjeta |
| `body` | 15 px / 1.5 / 400 | Texto del panel |
| `body-strong` | 15 px / 1.5 / 600 | Etiquetas, datos clave |
| `table` | 14 px / 1.4 / 400 | Celdas |
| `caption` | 13 px / 1.4 / 400 | Ayudas (**mínimo permitido** para texto con contenido) |

- Línea de lectura ≤ 75 caracteres; párrafos ≤ 4 líneas en el panel; sin mayúsculas sostenidas salvo `overline` (12 px, decorativo).
- El usuario puede ampliar el texto al 200 % sin perder contenido ni funciones.

---

## 4. Tokens

Valores completos en [`tokens.json`](tokens.json) y [`tokens.css`](tokens.css) (variables CSS). Los componentes usan **siempre tokens semánticos**, nunca hexadecimales.

| Familia | Valores |
|---|---|
| **Espaciado** (base 4 px) | 2 · 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64 · 80 px (`--space-1` … `--space-12`) |
| **Radios** | xs 4 · sm 6 · md 8 (botones, campos) · lg 12 (tarjetas) · xl 16 (modales) · full (insignias) |
| **Bordes** | 1 px `--border-default` (tarjetas, tablas), `--border-strong` (campos, 3:1), 2 px en error y foco |
| **Sombras** | `sm` `0 1px 2px` · `md` `0 4px 12px` (tarjetas elevadas, menús) · `lg` `0 12px 32px` (modales). El panel se apoya en **bordes**, no en sombras. |
| **Foco** | Anillo doble: 2 px blanco + 2 px Laguna 600 (`--shadow-focus`). Siempre visible; nunca `outline: none` sin sustituto. |
| **Movimiento** | 100 / 160 / 240 ms, curva `cubic-bezier(.2,0,0,1)`. Solo para transiciones de estado. Con `prefers-reduced-motion` todo pasa a 0 ms. |
| **Capas** | base 0 · sticky 10 · menús 20 · panel lateral 30 · modal 40 · avisos 50 |
| **Diseño** | barra lateral 248 px (72 colapsada) · barra superior 56 px · contenido máx. 1280 px · formularios máx. 720 px |
| **Controles** | alto 40 px (32 px compacto en escritorio); objetivo táctil **44 px** en tableta y móvil |
| **Densidad de tabla** | cómoda 48 px · compacta 36 px (preferencia por usuario) |
| **Puntos de quiebre** | sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536 |

---

## 5. Componentes base

Cada componente se especifica con anatomía, estados y reglas de accesibilidad. Se construirán sobre primitivas accesibles sin estilo (propuesta: Radix UI o React Aria) con el estilo propio de estos tokens [por validar en la fase de construcción].

### 5.1 Botones

| Variante | Uso | Estilo |
|---|---|---|
| **Primario** | La acción principal de la vista (máx. 1 por vista) | Fondo `action-primary`, texto blanco |
| **Secundario** | Acciones alternas | Fondo blanco, borde `border-strong` |
| **Terciario / fantasma** | Acciones de baja jerarquía, en tablas | Sin fondo, texto de enlace |
| **Peligro** | Baja, anulación, revocación | Fondo `action-danger`; siempre con confirmación y motivo |

- Tamaños: `md` 40 px, `sm` 32 px, `lg` 48 px (táctil). Etiqueta = verbo + objeto ("Cobrar", "Dar de baja").
- Estados: reposo, hover, `:focus-visible`, activo, **cargando** (se mantiene el ancho, spinner + texto "Guardando…", `aria-busy`), deshabilitado (explicar el motivo con texto de ayuda, no solo gris).
- Botones de solo icono: `aria-label` obligatorio y tooltip.

### 5.2 Campos de formulario

- Etiqueta visible **encima** del campo (nunca solo placeholder). Ayuda debajo en `caption`. Obligatorios: la regla es marcar los **opcionales** ("opcional"), porque la mayoría son obligatorios.
- Validación **al salir del campo** y al enviar; el mensaje dice cómo corregir ("Escriba un correo completo, por ejemplo ana@correo.pe"), con icono, `aria-invalid` y `aria-describedby`. Al enviar con errores, el foco pasa al primero y se resume en una alerta.
- Campos de dominio:
  - **DNI:** `inputmode="numeric"`, 8 dígitos, sin separadores. **CE / pasaporte:** alfanumérico (formato por validar).
  - **Celular:** acepta `+51`, espacios y guiones; se muestra `900 000 001`. `autocomplete="tel"`.
  - **Fecha de nacimiento:** campo de texto `dd/mm/aaaa` con selector opcional (más rápido que un calendario), valida rango.
  - **Importe:** `S/`, 2 decimales, `inputmode="decimal"`, alineado a la derecha, `tabular-nums`.
  - **Búsqueda de paciente:** *combobox* con resultados por DNI, nombre o celular; flechas + Enter.
  - **Motivo:** texto corto obligatorio (≥ 3 caracteres) con ejemplos; lo exige la API en cambios sensibles (ver 5.8).
- Autoguardado de borradores solo en formularios largos y **nunca** de datos clínicos en el navegador (ver 9).

### 5.3 Tablas

- Encabezado fijo (`sticky`), `scope="col"`, alineación: texto a la izquierda, números a la derecha. Fila entera clicable **y** con un enlace real en la celda principal (teclado y lectores de pantalla).
- Acciones de fila: máx. 2 visibles + menú "Más". Orden y filtros visibles; **paginación** (50 por defecto, coincide con la API) en vez de scroll infinito.
- Estados obligatorios: **cargando** (esqueleto de filas), **vacío** (qué es + acción sugerida), **error** (mensaje + "Reintentar"), **sin resultados** (limpiar filtros).
- Densidad cómoda/compacta. En móvil la tabla pasa a **lista de tarjetas** (ver 7).

### 5.4 Insignias de estado

Forma de píldora, 24 px, icono + texto; **no se comunican solo con color**. Un único lugar (`status` en `tokens.json`) define el tono de cada estado:

| Dominio | Estado → tono |
|---|---|
| **Cita** | Reservado → información · Confirmado → marca · Atendido → éxito · Cancelado → neutro · Ausente → peligro |
| **Pago** | Pagado → éxito · Parcial → advertencia · Pendiente → neutro · Crédito → acento · Anulado → neutro |
| **Comprobante** *(estados locales; mapeo con Apiworking/SUNAT [por validar])* | Pendiente de envío → neutro · Enviado → información · Emitido → éxito · Rechazado → peligro · Error reintentable / Requiere conciliación / Anulación pendiente → advertencia · Anulado → neutro |
| **Consentimiento** | Vigente → éxito · Revocado → neutro · Sin registro → advertencia |
| **Paciente** | Activo → éxito · Inactivo → neutro · Menor sin representante → advertencia · Posible duplicado → advertencia |
| **Stock** | Suficiente → éxito · Bajo → advertencia · Agotado → peligro |

Iconos: ● información, ◆ marca, ✓ éxito, – neutro, ✕ peligro, ! advertencia, ★ acento (en la implementación, iconos de línea del set elegido).

### 5.5 Tarjetas

Borde 1 px, radio 12, relleno 24 (16 en móvil), título `h3`, acción opcional arriba a la derecha. Tarjeta de **dato** = etiqueta pequeña + cifra grande (`Manrope`, `tabular-nums`) + contexto. Sin sombra por defecto; elevada (`md`) solo para elementos que flotan. No anidar tarjetas dentro de tarjetas.

### 5.6 Modales y paneles laterales

- **Modal** solo para confirmaciones y decisiones cortas; **panel lateral** (derecha) para crear/editar (nueva cita, nuevo paciente), de modo que el contexto sigue visible.
- Atrapa el foco, `Esc` cierra, devuelve el foco al disparador, `role="dialog"` + `aria-modal` + título como `aria-labelledby`. Tamaños: 480 / 640 px. Nunca apilar modales.
- Botón primario a la derecha, "Cancelar" a su izquierda; en acciones destructivas el foco inicial va a "Cancelar".

### 5.7 Alertas y avisos

| Tipo | Uso | Comportamiento |
|---|---|---|
| **Alerta en línea** | Información persistente de la pantalla (duplicado, menor sin representante) | Borde izquierdo 4 px + icono + título + una acción |
| **Aviso (toast)** | Confirmación breve ("Cobro registrado") | 5 s, esquina inferior, `aria-live="polite"`; los errores **no** desaparecen solos (`role="alert"`) |
| **Banner de sistema** | Sin conexión con Apiworking, sesión por vencer | Fijo bajo la barra superior |

### 5.8 Diálogos de dominio

Derivados de reglas del backend; se implementan una sola vez y se reutilizan:

- **Diálogo de motivo (`ReasonDialog`):** campo de motivo obligatorio, texto explicativo de qué se conserva ("El archivo se conserva; solo dejará de estar disponible"). Lo usan: reemplazar DNI, cambiar celular/correo, revocar consentimiento, dar de baja un adjunto o un paciente, finalizar un vínculo de representante, anular un pago.
- **Diálogo de reautenticación (`ReauthDialog`):** pide la contraseña para confirmar el cierre de una evolución. Texto fijo: "Confirma que usted realiza esta acción. **No es una firma legal ni digital.**" **[por validar]**
- **Aviso de sesión por vencer (`SessionExpiryDialog`):** el access token dura 15 minutos y se **renueva en silencio** con el refresh token (cookie HttpOnly). El diálogo solo aparece si la renovación falla o la sesión llegó a su tope (inactividad o límite absoluto): avisa, ofrece conservar el borrador no clínico y vuelve al inicio de sesión. Las renovaciones deben **serializarse** (una a la vez, también entre pestañas).

### 5.9 Navegación

- **Barra lateral** (escritorio, oscura `neutral-900`): logo, **selector de contexto "Clínica · Sede"** (obligatorio por la API: el usuario elige clínica/sede activa; si solo tiene una, se omite), módulos con icono + etiqueta, y al pie el usuario y "Cerrar sesión". Colapsable a 72 px (solo iconos con tooltip). Solo se muestran los módulos permitidos por el rol (la ausencia de permiso oculta, nunca "deshabilita").
- **Barra superior:** búsqueda global de pacientes (`/` la enfoca), botón primario contextual ("+ Nuevo paciente"), avisos y menú de usuario.
- **Pestañas** dentro de una entidad (ficha del paciente); `role="tablist"`, flechas para moverse, la pestaña activa con subrayado de 3 px + texto de marca.
- **Móvil/tableta vertical:** barra inferior con 4-5 destinos (Hoy, Agenda, Pacientes, Caja, Más) y la búsqueda como icono superior.
- **Migas de pan** solo en jerarquías de 3+ niveles.
- Iconos de línea (propuesta: Lucide, licencia ISC [por validar]), 20 px, 1.75 px de trazo, siempre acompañados de texto en navegación principal.
- Atajos (opcionales, visibles en ayuda): `/` buscar · `N` nuevo paciente/cita según pantalla · `G` luego `A`/`P`/`C` ir a Agenda/Pacientes/Caja · `Esc` cerrar.

### 5.10 Componentes de dominio

| Componente | Descripción |
|---|---|
| **DuplicateWarning** | Alerta de advertencia con la lista de coincidencias (nombre, nacimiento si se puede ver, motivo: "mismo nombre y fecha", "mismo celular"), confianza (alta/media/baja) y dos acciones: "Abrir ficha" y "Es otra persona, continuar". **Nunca fusiona.** |
| **IdentifierConflict** | Bloqueo (peligro) cuando el DNI ya existe: muestra la ficha existente con "Abrir ficha". |
| **MinorBanner** | Advertencia "Menor de edad sin representante" con acción "Agregar representante". |
| **ConsentChips** | Tres chips independientes (Clínico, Fidelización, Marketing) con estado vigente/revocado/sin registro y fecha. |
| **AttachmentUploader** | Arrastrar/seleccionar, muestra tipos permitidos (PDF, JPG, PNG, WebP) y tamaño máximo; error claro por tipo/tamaño; **la descarga se hace con una petición autenticada** (nunca un enlace público). |
| **SyncStatus** | Estado de lo enviado a Apiworking (cobro/comprobante): icono + texto + "Reintentar" cuando corresponda; tiempo desde el último intento. |
| **EmptyState** | Icono simple, una frase de qué es, una acción. |
| **MaskedValue** | Valor sensible parcialmente oculto ("***678") con botón "Mostrar" que se audita (cuando el backend lo exija). |

---

## 6. Wireframes

Esquemas de **estructura y jerarquía**, no de estilo final. Convenciones: `[Botón]`, `( ) campo`, `▓` acción primaria, `░` placeholder, `!` advertencia, `✓` estado, `▸` elemento seleccionable.

### 6.1 Inicio de sesión y elección de contexto

```
┌───────────────────────────────────────────────────────────────────────────┐
│  ApiDental  by Apiworking                                                 │
│                                                                           │
│        ┌───────────────────────────────────┐                              │
│        │  Ingrese a su clínica             │   (tarjeta centrada, 420 px) │
│        │                                   │                              │
│        │  Correo                           │                              │
│        │  ( ░░░░░░░░░░░░░░░░░░░░░░ )       │                              │
│        │  Contraseña            [Mostrar]  │                              │
│        │  ( ░░░░░░░░░░░░░░░░░░░░░░ )       │                              │
│        │                                   │   Error genérico:            │
│        │  [▓▓▓▓▓▓ Ingresar ▓▓▓▓▓▓]         │   "Correo o contraseña       │
│        │  ¿Olvidó su contraseña?           │    incorrectos" (no revela   │
│        └───────────────────────────────────┘    cuál). 429: "Demasiados   │
│                                                 intentos; espere un min." │
└───────────────────────────────────────────────────────────────────────────┘

Paso 2 (solo si hay más de un contexto; si hay uno, se entra directo)
┌───────────────────────────────────────┐
│  ¿Dónde va a trabajar hoy?            │
│  ▸ Clínica Demo · Sede Norte          │  ← rol: Recepcionista
│  ▸ Clínica Demo · Sede Sur            │  ← rol: Odontólogo
│  ▸ Otra Clínica · Todas las sedes     │  ← rol: Administrador
│  (recordar mi última elección)        │
└───────────────────────────────────────┘
```

Reglas: autofoco en correo; `Enter` envía; gestor de contraseñas permitido (`autocomplete="username/current-password"`); sin 2FA en el MVP; "¿Olvidó su contraseña?" aparece cuando exista el flujo.

### 6.2 Dashboard "Hoy" (varía por rol)

```
┌ Sidebar ┬──────────────────────────────────────────────────────────────────┐
│ ApiDent │ [ Buscar paciente por DNI, nombre o celular    ( / ) ] [+ Paciente]│
│ Clínica │ Hola, Marta · mar 14 oct                                          │
│ Demo ▾  │                                                                   │
│ ▣ Hoy   │ ┌─Citas hoy─┐ ┌─Por confirmar─┐ ┌─Ausencias─┐ ┌─Por cobrar──────┐│
│ ▤ Agenda│ │  18       │ │  4            │ │  2        │ │ S/ 1,240.50     ││
│ ☺ Pacien│ │ 12 hechas │ │ [Confirmar]   │ │ [Seguir]  │ │ 4 pacientes     ││
│ S/ Caja │ └───────────┘ └───────────────┘ └───────────┘ └─────────────────┘│
│ ▥ Compr.│ Próximas citas                          Pendiente de atención      │
│ ▦ Invent│ ┌──────────────────────────────────────┐ ┌────────────────────────┐│
│ ▧ Report│ │ 09:00 Lucía D.  Control   ◆Confirmado│ │ ! Comprobante rechazado││
│ ⚙ Config│ │ 09:30 Mateo D.  Limpieza  ●Reservado │ │   B001-102 [Corregir]  ││
│         │ │ 10:15 Jorge D.  Endodon.  ✕Ausente   │ │ ! 2 comprobantes       ││
│ M. Ruiz │ │                          [Ver agenda]│ │   pendientes [Revisar] ││
│         │ └──────────────────────────────────────┘ │ ! Stock bajo: 3 prod.  ││
└─────────┴──────────────────────────────────────────┴────────────────────────┘
```

| Rol | Tarjetas y listas principales |
|---|---|
| Recepción | Citas por confirmar, llegadas, ausencias por seguir, pacientes nuevos/duplicados por revisar |
| Odontólogo | Mi agenda de hoy, siguiente paciente (con alertas), pendientes por cerrar |
| Cajero | Caja (abierta/cerrada), cobros del día por medio de pago, comprobantes pendientes/rechazados |
| Administrador de clínica | Indicadores del día/semana, conciliación pendiente, stock bajo, usuarios |

Regla: **máximo 4 tarjetas de cifra + 2 listas**; cada cifra enlaza a la lista que la explica. Todo es accionable; sin gráficos decorativos (los gráficos van en Reportes).

### 6.3 Agenda

```
┌ Agenda ──────────────────────────────────────────────────────────────────────┐
│ [‹] [Hoy] [›]  mar 14 oct 2026   [Día|Semana]   Sede ▾  Consultorio ▾  Espec ▾│
│ Odontólogo: [x] Dr. Ríos  [x] Dra. Soto  [ ] Dr. Vega            [+ Nueva cita]│
├──────┬───────────────────────────┬───────────────────────────┬───────────────┤
│      │ Dr. Ríos · Cons. 1        │ Dra. Soto · Cons. 2       │               │
│ 09:00│ ┌───────────────────────┐ │ ┌───────────────────────┐ │               │
│      │ │ Lucía D. · Control    │ │ │ (libre)  [+]          │ │               │
│ 09:30│ │ ◆ Confirmado          │ │ └───────────────────────┘ │               │
│      │ └───────────────────────┘ │ ┌───────────────────────┐ │               │
│ 10:00│ ┌───────────────────────┐ │ │ Mateo D. · Limpieza   │ │               │
│      │ │ Jorge D. · Endodoncia │ │ │ ● Reservado ! menor   │ │               │
│ 10:30│ │ ✕ Ausente  [Seguir]   │ │ └───────────────────────┘ │               │
└──────┴───────────────────────────┴───────────────────────────┴───────────────┘
Panel lateral "Nueva cita":  Paciente (buscador) · Servicio · Odontólogo · Fecha/hora
  (choques de odontólogo/consultorio se avisan al elegir) · Notas      [▓ Reservar]
```

- Un bloque = 15 min (configurable); color de **borde izquierdo** y **insignia** por estado, nunca solo color. Los bloques ausentes muestran la acción "Seguir".
- Teclado: flechas mueven entre huecos, `Enter` crea, `Esc` cierra. Arrastrar para reprogramar **y** botón "Reprogramar" (alternativa accesible).
- Cambiar de estado: menú en el bloque (Confirmar, Atender, Cancelar con motivo, Marcar ausente).
- Móvil: lista por hora con el odontólogo como filtro; "Nueva cita" como pantalla completa.

### 6.4 Ficha del paciente

```
┌ ‹ Pacientes ────────────────────────────────────────────────────────────────┐
│ Mateo Demo Menor                 DNI 90000002 · 9 años · ♂                   │
│ ✓ Activo   ! Menor sin representante      Cel. 900 000 002        [Editar] ▾ │
│ ! Posible duplicado: "Mateo Demo" mismo nombre y nacimiento  [Revisar]       │
├ Resumen │ Contacto │ Representantes │ Consentimientos │ Adjuntos │ Cobros ────┤
│ ┌── Identificación ────────────────┐ ┌── Próxima cita ──────────────────────┐ │
│ │ DNI        90000002   [Cambiar]  │ │ mié 15 oct · 09:30 · Dr. Ríos        │ │
│ │ Nacimiento 30/09/2017            │ │ ◆ Confirmado        [Reprogramar]    │ │
│ └──────────────────────────────────┘ └──────────────────────────────────────┘ │
│ ┌── Consentimientos ───────────────┐ ┌── Saldo ─────────────────────────────┐ │
│ │ Clínico ✓ · Fidelización – ·     │ │ S/ 0.00                              │ │
│ │ Marketing –        [Registrar]   │ │                                      │ │
│ └──────────────────────────────────┘ └──────────────────────────────────────┘ │
│ (Historia clínica y odontograma: pestaña visible solo con permiso clínico)    │
└───────────────────────────────────────────────────────────────────────────────┘
```

- La **cabecera es fija**: nombre, DNI, edad y las alertas más importantes siempre visibles. Alergias y alertas clínicas irán aquí cuando existan.
- La vista depende del permiso: el **cajero** solo ve identificación y contacto; no ve pestañas de representantes, consentimientos ni adjuntos. Las pestañas no permitidas **no se muestran**.
- En **Adjuntos**: lista (nombre, tipo, tamaño, fecha, quién subió), "Descargar" (petición autenticada, sin URL pública), "Dar de baja" (diálogo de motivo). Los archivos dados de baja se ven solo con permiso de gestión.
- **Cambiar DNI/celular/correo** abre el diálogo de motivo y deja el valor anterior como historial.

### 6.5 Odontograma

```
┌ Odontograma · Lucía Demo · versión 3 (14/10/2026)   [Historial ▾] [Vista tabla]│
│ Permanente ◉  Temporal ○                    [Guardar nueva versión] [Exportar PDF]│
│ 18 17 16 15 14 13 12 11 │ 21 22 23 24 25 26 27 28     Leyenda                   │
│ ▢  ▢  ▣  ▢  ▢  ▢  ▢  ▢  │ ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢     ■ Patología / por tratar │
│ ───────────────────────────────────────────────────    ■ Tratamiento realizado  │
│ 48 47 46 45 44 43 42 41 │ 31 32 33 34 35 36 37 38     ■ Pieza ausente  ▢ Sano  │
│ ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢  │ ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢                               │
├ Pieza 16 · primer molar superior ───────────────────────────────────────────────┤
│  Superficies:  ┌─V─┐   Estado por superficie: ▸ Oclusal  [ Caries ▾ ]           │
│                │M O D│                         ▸ Mesial   [ Sano   ▾ ]           │
│                └─P─┘   Observación: ( ░░░░░░░░ )          [Aplicar] [Limpiar]   │
├────────────────────────────────────────────────────────────────────────────────┤
│ Formato oficial MINSA: por validar · El odontograma no genera tratamientos ni  │
│ presupuestos.                                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Numeración FDI. Cada pieza es una cruz de 5 superficies (V, P/L, M, D, O) con **color + símbolo + etiqueta**, no solo rojo/azul (convención clásica rojo = patología, azul = realizado; **[por validar con el formato MINSA]**).
- **Cada guardado crea una versión nueva** (nunca sobrescribe); el selector de versiones permite comparar. "Exportar PDF" produce la copia para el paciente.
- **Alternativa accesible obligatoria:** "Vista tabla" lista pieza → superficie → estado, navegable con teclado y lector de pantalla.
- Tableta (uso en sillón): piezas de ≥ 44 px, el panel de la pieza sube como **hoja inferior**; sin arrastres complejos.
- No se muestran sugerencias automáticas de tratamiento (fuera de alcance de P0).

### 6.6 Cobro

```
┌ Cobro · Lucía Demo Adulta · Visita 14/10 ───────────────────────────────────┐
│ Conceptos                                         │ Resumen                  │
│ ┌────────────────────────────┬────┬────────────┐  │ Total        S/ 180.00   │
│ │ Control odontológico       │ 1  │ S/ 80.00   │  │ Pagado       S/ 100.00   │
│ │ Pasta dental (producto)    │ 2  │ S/ 50.00   │  │ ─────────────────────    │
│ │ [+ Agregar concepto]       │    │            │  │ Saldo        S/ 80.00    │
│ └────────────────────────────┴────┴────────────┘  │ (cuenta por cobrar)      │
│ Pagos (pueden combinarse)                         │                          │
│ ┌ Efectivo ▾ ┬ S/ 60.00 ┬ ref ░░ ┬ [Quitar] ┐     │ Comprobante              │
│ │ Yape     ▾ ┬ S/ 40.00 ┬ ref 8890┬ [Quitar] │     │ Tipo: Boleta ▾ (por val.)│
│ └ [+ Agregar medio de pago]                   ┘   │ Cliente: DNI 90000001    │
│ Medios: efectivo · Yape · Plin · transferencia ·  │ ☑ Emitir al registrar    │
│ POS/tarjeta · crédito                             │                          │
│                              [Cancelar] [▓ Registrar cobro]                  │
└───────────────────────────────────────────────────────────────────────────────┘
Después de registrar:
  ✓ Cobro guardado   Comprobante: ─ Pendiente de envío  (se reintentará solo)
  [Ver comprobante] [Imprimir recibo] [Nuevo cobro]      ← si hay corte con Apiworking
  el cobro NO se pierde; el estado cambia a ✓ Emitido o a ! Requiere conciliación.
```

- La suma de los medios de pago se valida en vivo contra el total; el saldo se calcula solo. Solo se puede registrar con **caja abierta** (si no, aviso con acción "Abrir caja").
- La interfaz muestra los **estados locales** del comprobante con lenguaje llano; el detalle de errores de SUNAT/Apiworking se muestra solo en Comprobantes → Conciliación.
- Nunca se pide ni se envía información clínica para facturar; el concepto es comercial/genérico.
- Anular un pago o un comprobante abre el diálogo de motivo y exige permiso.

### 6.7 Comprobantes y conciliación (complemento)

Lista con filtros por estado y antigüedad; columna de estado con insignia; acciones por fila: "Reintentar", "Corregir y reenviar", "Vincular manualmente", "Resolver con motivo". Un banner superior resume: "2 pendientes · 1 rechazado".

---

## 7. Reglas responsive

| Contexto | Dispositivo | Prioridad de diseño |
|---|---|---|
| Recepción y caja | Escritorio/portátil (≥ 1024 px) | Densidad, teclado, múltiples datos a la vez |
| Odontólogo en sillón | **Tableta** (768-1024 px) horizontal/vertical | Objetivos táctiles de 44 px, odontograma, lectura rápida |
| Consulta rápida | Móvil (≥ 360 px) | Buscar paciente, ver agenda, confirmar citas; no se diseñan flujos largos |

- **Mobile-first en CSS**, probado a 360, 768, 1024 y 1440 px. Cero desplazamiento horizontal de página (salvo tablas en su propio contenedor).
- **< 768 px:** barra lateral → barra inferior; tablas → listas de tarjetas (la columna principal como título y 2-3 datos clave); paneles laterales → pantalla completa; formularios a una columna.
- **768-1023 px:** barra lateral colapsada (72 px); tablas conservan columnas esenciales; objetivos táctiles de 44 px.
- **≥ 1024 px:** barra lateral completa; formularios en 2 columnas (máx. 720 px de ancho); paneles laterales de 480-640 px.
- **Orientación:** nada depende de una orientación concreta.
- **Entrada:** todo funciona con **teclado, ratón y táctil**; sin acciones solo en `:hover`; sin gestos obligatorios (hay alternativa por botón).
- **Zoom:** usable al 200 % y a 400 % en una columna (reflujo, WCAG 1.4.10).
- **Impresión:** hojas propias para el recibo de cobro y el odontograma para el paciente (se diseñan en blanco/negro legible).

---

## 8. Accesibilidad (meta: WCAG 2.2 nivel AA)

| Área | Reglas |
|---|---|
| **Contraste** | Texto ≥ 4.5 : 1 (grande ≥ 3 : 1); componentes e iconos esenciales ≥ 3 : 1. Validado por script en cada cambio de tokens. |
| **Color** | Nunca es el único canal: estados con icono + texto; odontograma con símbolo + etiqueta; errores con icono + mensaje. |
| **Teclado** | Todo operable sin ratón; orden de foco lógico; foco **siempre visible** (anillo doble, ≥ 3 : 1) y no oculto por barras fijas (WCAG 2.4.11); "Saltar al contenido" como primer enlace. |
| **Objetivos** | ≥ 24×24 px en escritorio (mínimo AA 2.5.8) y **44×44 px** en táctil. |
| **Formularios** | Etiquetas visibles y asociadas; errores identificados y descritos (3.3.1/3.3.3); sugerencias de corrección; `autocomplete` correcto; no pedir lo ya ingresado (3.3.7). |
| **Estructura** | Un `h1` por pantalla, jerarquía de títulos sin saltos, *landmarks* (`header`, `nav`, `main`), `lang="es-PE"`, título de página único por ruta. |
| **Patrones ARIA** | Siguen las prácticas de WAI-ARIA para *dialog*, *tabs*, *combobox*, *menu*, *grid* (agenda) y *alert*; se prefiere HTML nativo antes que ARIA. |
| **Avisos dinámicos** | Resultados de búsqueda, guardados y errores se anuncian con `aria-live` (`polite`; `assertive` solo en errores bloqueantes). |
| **Tablas** | `caption` o `aria-label`, `th scope`, orden anunciado; la agenda ofrece una vista de lista equivalente. |
| **Odontograma** | Vista tabla equivalente con las mismas acciones; cada pieza es un botón con nombre ("Pieza 16, primer molar superior, oclusal: caries"). |
| **Tiempo** | Aviso de vencimiento de sesión con opción de extender/guardar (2.2.1); sin límites de tiempo ocultos. |
| **Movimiento** | `prefers-reduced-motion` respetado; sin parpadeos; sin animación esencial. |
| **Texto** | Reflujo y ampliación al 200 %; espaciado de texto ajustable sin perder contenido (1.4.12). |
| **Idioma y lenguaje llano** | Español claro; abreviaturas explicadas la primera vez; evitar tecnicismos. |
| **Pruebas** | `axe` automatizado en CI + revisión manual con teclado y lector de pantalla (NVDA/VoiceOver) por cada flujo crítico antes de liberar. |

---

## 9. Seguridad y privacidad en la interfaz

Reglas que el frontend debe respetar por la naturaleza de los datos:

- **Sin datos personales en la URL** (nada de DNI, nombres ni teléfonos en rutas o *query strings*): se usa el `id` UUID interno. Tampoco en `document.title`, analítica, *logs* de consola ni mensajes de error enviados a terceros.
- **Token de acceso solo en memoria** (no en `localStorage`/`sessionStorage`); al cerrar la pestaña termina la sesión. Cierre automático por inactividad con aviso previo. Sin analítica de terceros dentro de `/admin`.
- **Sin recursos de terceros** en el panel (fuentes, iconos y *scripts* autoalojados) para no filtrar la IP ni el uso.
- **Privacidad en pantalla:** tras inactividad breve se difumina el contenido con pacientes y se pide reanudar; el cajero ve solo la vista mínima porque el servidor así responde (la interfaz no oculta datos que el servidor envió: **el filtro real está en la API**).
- **Descargas:** los adjuntos se piden con la sesión y se entregan como *blob* (no existe URL pública ni se muestra ninguna ruta de almacenamiento).
- **Datos clínicos futuros:** no se guardan borradores en el navegador; no se cachean respuestas clínicas (`Cache-Control: no-store` ya lo fija la API en descargas).
- **Acciones sensibles** siempre con confirmación y, cuando la API lo exige, motivo.
- **Mensajes de error** nunca revelan si un usuario existe ni detalles técnicos; se muestra el `requestId` de la respuesta para soporte.

---

## 10. Rendimiento y baja carga cognitiva

**Presupuestos (propuestos, a medir en un equipo modesto con red de clínica):**

| Medida | Meta |
|---|---|
| Primer contenido útil del panel (LCP) | ≤ 2.5 s |
| JavaScript inicial del panel (comprimido) | ≤ 250 KB; rutas con *lazy loading* |
| Búsqueda de paciente | Resultados en ≤ 300 ms tras dejar de teclear (retardo de 250 ms) |
| Interacción (INP) | ≤ 200 ms |
| Fuentes | Subconjunto latino, ≤ 4 archivos, precargadas las críticas |

**Reglas para reducir la carga cognitiva:**

1. **Una acción primaria por vista.** El resto, secundarias.
2. **Valores por defecto inteligentes** (sede y odontólogo del contexto, fecha de hoy, forma de pago más usada) y **no pedir lo que ya se sabe**.
3. **Divulgación progresiva:** lo habitual a la vista, lo avanzado tras "Más opciones".
4. **Consistencia:** el mismo patrón para lo mismo (el diálogo de motivo siempre se ve igual).
5. **Mostrar el estado del sistema:** guardando, guardado, pendiente de enviar, sin conexión.
6. **Prevenir antes que corregir:** avisar choques de agenda y duplicados *mientras* se escribe.
7. **Confirmar solo lo destructivo**; lo reversible se *deshace* con un aviso "Deshacer" de 8 s cuando el backend lo permita.
8. **Lenguaje del consultorio**, frases cortas, sin mayúsculas gritadas, sin jerga.
9. **Densidad ajustable** (cómoda/compacta) por usuario; el valor por defecto es cómodo.
10. **Cero decoración en el panel:** sin degradados, ilustraciones grandes ni animaciones; los espacios en blanco son suficientes.

---

## 11. Sitio comercial (Next.js) — estructura propia

Objetivo: captar clínicas pequeñas y medianas de Perú; mensajes de **beneficio operativo**, no lista de funciones. Sin datos clínicos ni lógica operativa; enlaza a `/admin`.

| # | Sección | Contenido (a redactar con voz propia) |
|---|---|---|
| 1 | **Cabecera** | Logo, Beneficios, Módulos, Integración, Preguntas, **Ingresar** (a `/admin`) y CTA "Solicitar demo". |
| 2 | **Hero** | Promesa operativa en una frase ("Menos ausencias, cobros ordenados y comprobantes sin doble digitación"), CTA principal "Solicitar demo", CTA secundaria "Ver cómo funciona"; imagen del **panel real** con datos ficticios. |
| 3 | **El problema** | 3 dolores del consultorio (agenda con huecos y ausencias, cobros y saldos en cuadernos, facturar aparte). |
| 4 | **Beneficios** | 4 tarjetas por resultado: agenda ordenada, cobros y saldos claros, facturación electrónica integrada, información del paciente segura. |
| 5 | **Módulos** | Tarjetas: Agenda, Pacientes, Odontograma, Caja y comprobantes, Inventario, Reportes. Los no disponibles se rotulan **"Próximamente"**. |
| 6 | **Integración Apiworking** | El diferencial: facturación electrónica nativa; fidelización y reseñas/ApiReview **cuando estén disponibles** (hoja de ruta honesta). |
| 7 | **Cómo funciona** | 3 pasos: demo → configuración de clínica y sedes → operación. |
| 8 | **Demo / prueba** | Formulario corto (nombre, clínica, teléfono, sedes) con consentimiento de contacto; la demo usa datos ficticios. |
| 9 | **Seguridad y privacidad** | Solo afirmaciones **verificables** (acceso por rol, auditoría, adjuntos privados, respaldos). **No** declarar cumplimiento MINSA/SUNAT/Ley de datos hasta validarlo [por validar]. |
| 10 | **Testimonios** | **Solo reales y con permiso escrito.** Hasta tenerlos, la sección no se publica (ni se inventan cifras, nombres o logos de clientes). |
| 11 | **Preguntas frecuentes** | Acordeón accesible: implementación, datos, soporte, respaldos, facturación, migración. |
| 12 | **Planes** | **Por validar:** no se publican precios ni planes inventados. |
| 13 | **Cierre y pie** | Segundo CTA de demo, contacto, aviso de privacidad y términos (los textos legales los redacta un abogado [por validar]). |

SEO: `<title>` y metadatos por página, `sitemap.xml`, `robots.txt`, datos estructurados (`SoftwareApplication`, `FAQPage`) solo con contenido real, imágenes con `alt`, rendimiento (imágenes AVIF/WebP, LCP ≤ 2.5 s). Accesibilidad con las mismas reglas de la sección 8. Un único CTA primario repetido, sin ventanas emergentes.

---

## 12. Implementación futura (propuesta, sin código aún)

- `apps/admin`: React + Vite, base `/admin/`. Estilos con **CSS variables de `tokens.css`** (más CSS Modules o una utilidad como Tailwind configurada desde `tokens.json` [por decidir]). Primitivas accesibles sin estilo (Radix UI o React Aria). Iconos Lucide. Validación de formularios alineada con las reglas de la API.
- `apps/web`: Next.js, mismos tokens.
- `packages/shared` (cuando exista): tokens y tipos de las respuestas de la API.
- Catálogo de componentes (Storybook o similar) con pruebas de accesibilidad automatizadas; pruebas visuales de regresión de los estados críticos.
- Los tokens se regeneran con `node docs/diseno/tools/build.mjs`; el script **falla** si algún contraste baja de AA.

---

## 13. Lista de aceptación del diseño (antes de construir)

- [ ] Marca (logo) refinada o sustituida por un diseñador y revisada para originalidad; registro de marca evaluado [por validar].
- [ ] Revisión de originalidad: ningún elemento (texto, imagen, icono, nombre, estructura exacta) proviene de otro producto.
- [ ] Licencias de Inter, Manrope y del set de iconos verificadas y archivadas.
- [ ] Wireframes revisados con 1 recepcionista, 1 odontólogo y 1 administrador de Clínica Demo; ajustes registrados.
- [ ] Odontograma: formato y simbología MINSA validados [por validar]; hasta entonces, rotulado como provisional.
- [ ] Estados de comprobante: mapeo con Apiworking/SUNAT confirmado [por validar].
- [ ] Textos legales (privacidad, términos, consentimientos) redactados por un profesional [por validar].
- [ ] `node docs/diseno/tools/build.mjs --check` sin fallos.

## 14. Decisiones y riesgos abiertos

1. **Marca provisional:** el ícono actual es una propuesta técnica, no una identidad final.
2. **Recuperación de contraseña** (backend): sigue pendiente; la interfaz no debe ofrecer "¿Olvidó su contraseña?" hasta que exista. Las altas son por **invitación** (pantalla de aceptación en `/admin/aceptar-invitacion`, con el token en el fragmento de la URL).
3. **Política de acceso clínico:** define qué pestañas y datos clínicos aparecen por rol (ver [`politica-acceso-clinico.md`](../arquitectura/politica-acceso-clinico.md)).
4. **Mapeo de estados Apiworking/SUNAT** y tipos de comprobante: provisional.
5. **Mensajes comerciales** sobre cumplimiento normativo: prohibidos hasta validar.
6. **Dispositivos reales de la Clínica Demo** (tamaño de tableta, navegador, resolución) para ajustar las pruebas responsive.
