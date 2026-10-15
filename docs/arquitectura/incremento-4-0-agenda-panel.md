# Incremento 4.0: panel React inicial y agenda de citas

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15). Demuestra en pantalla el flujo **paciente → cita → atención clínica → odontograma** reutilizando los módulos seguros de 3.x. **No** incluye cobros, caja, facturación, inventario, WhatsApp/SMS/Google Calendar, pagos en línea ni planes de tratamiento. Tampoco recordatorios ni outbox de notificaciones (decisión: no agregan valor sin canal de entrega probado).

## 1. Agenda (API)
Modelo (migración `20261021000000_agenda`): consultorios (`rooms`), especialidades, servicios con duración configurable (`agenda_services`, múltiplos de 5 min, ≤ 480), especialidades por odontólogo, **horarios recurrentes** (`schedule_rules`: día 1–7, hora de inicio/fin, vigencia, consultorio habitual), **bloqueos** (`schedule_blocks`: vacaciones, mantenimiento; solo se *liberan* con motivo) y **citas** (`appointments`, con versión optimista). Todo en hora de Lima (UTC-5, sin horario de verano).

| Estado | Etiqueta | Transiciones |
|---|---|---|
| `RESERVED` | Reservado | → Confirmado, Atendido, Cancelado, Ausente |
| `CONFIRMED` | Confirmado | → Atendido, Cancelado, Ausente |
| `ATTENDED` / `CANCELLED` / `NO_SHOW` | Atendido / Cancelado / Ausente | terminales (inmutables) |

Cancelar, marcar ausencia y reprogramar **exigen motivo** (≥ 3 caracteres) y se auditan (`APPOINTMENT_CREATED/CONFIRMED/RESCHEDULED/CANCELLED/NO_SHOW/ATTENDED/NOTES_UPDATED`, `AGENDA_*` de configuración). Ausencia solo desde la hora de la cita. Reprogramar devuelve la cita a *Reservado* y suma `rescheduledCount`. La base de datos impone las transiciones, la inmutabilidad del núcleo (clínica, paciente, creador), el motivo y la no eliminación (triggers), igual que la API.

### Doble reserva: control transaccional
Cada cita y cada bloqueo ocupan **huecos de 5 minutos** en `appointment_slots`, con clave primaria (recurso, hueco) para el **odontólogo** y para el **consultorio**. Dos solicitudes simultáneas no pueden ocupar el mismo recurso: la segunda falla con `409 SLOT_TAKEN` aunque ambas pasen las verificaciones. Las escrituras corren en transacción `READ COMMITTED` con reintento ante deadlock, bloquean la fila de la cita (y del paciente, para que no tenga dos citas a la vez: `PATIENT_BUSY`) y ocupan los huecos en orden estable. Las citas y bloqueos comparten los huecos: chocan entre sí en ambos sentidos.

Otros errores con código: `OUTSIDE_SCHEDULE`, `NO_ROOM`, `VERSION_CONFLICT`, `INVALID_TRANSITION`, `TOO_EARLY`, `SERVICE_NOT_OFFERED`, `SCHEDULE_OVERLAP`.

### Rutas (`/v1`)
| Ruta | Permiso |
|---|---|
| `GET /agenda/rooms\|specialties\|services\|dentists\|schedules\|availability\|calendar` | `appointment:read` |
| `POST/PATCH /agenda/rooms\|specialties\|services`, `PUT /agenda/dentists/:id/specialties`, `POST /agenda/schedules` y `…/:id/deactivate`, `POST /agenda/blocks` y `…/:id/release` | `agenda:manage` |
| `GET /appointments`, `GET /appointments/:id` | `appointment:read` |
| `POST /appointments`, `PATCH /appointments/:id` (notas), `POST …/confirm\|reschedule\|cancel\|no-show` | `appointment:manage` |
| `POST /appointments/:id/start-attention` | `appointment:attend` + `clinical:write` |

Permisos por rol: administrador de clínica (leer, gestionar, configurar), **recepción** (leer, gestionar), **odontólogo** (leer, atender), asistente y Director (solo leer). El administrador de plataforma no tiene acceso. Aislamiento: todo se filtra por clínica; un actor limitado a una sede solo ve y opera esa sede; lo ajeno responde 404 uniforme.

## 2. Cita → relación asistencial → visita (sin escalamiento)
Recepción agenda; **nunca obtiene acceso clínico**. El odontólogo de la cita la abre con `start-attention` (ventana: desde 30 min antes del inicio hasta 6 h después del fin; en la sede de la cita). En **una sola transacción**: bloquea cita y odontólogo, reutiliza una relación vigente o crea una de origen `APPOINTMENT` (`sourceRef` = cita, sede de la cita, vigencia = fin de la cita + 30 días **[por validar]**, creada «por» quien agendó o confirmó), abre la visita (`appointmentId`) y marca la cita *Atendido* con su `visitId`. Es idempotente. Si la cita ya tiene visita abierta del mismo paciente y odontólogo: `409 VISIT_ALREADY_OPEN`.

**Separación de funciones:** quien agendó o confirmó la cita debe ser distinto del odontólogo y de quien le otorgó su rol de odontólogo; si no, `403 SEPARATION_OF_DUTIES` y auditoría `ESCALATION_BLOCKED`. Nadie agenda citas a su propia agenda. La vista de la cita solo incluye `visitId` para perfiles clínicos.

## 3. Panel (`apps/admin`)
React 19 + Vite + TypeScript, servido bajo `/admin/` (`base`), react-router, tokens de `docs/diseno/tokens.css` (Laguna/Ámbar), Inter y Manrope autoalojadas (`@fontsource-variable`), iconos Lucide. Componentes propios según el sistema de diseño: botones (primario/secundario/terciario/peligro, estado cargando), campos con etiqueta encima y error asociado, tablas con estados cargando/vacío/error/sin resultados (tarjetas en móvil), insignias de estado con icono + texto, panel lateral, `ReasonDialog`, avisos (toasts con `aria-live`; los errores no desaparecen solos), enlace «Saltar al contenido», foco atrapado en modales, `prefers-reduced-motion`.

- **Sesión:** token de acceso solo en memoria; renovación con la cookie HttpOnly (`X-Requested-With: ApiDental`) **serializada** (varias solicitudes con 401 comparten una renovación); si falla, vuelve al inicio con aviso. Si hay varios contextos, pantalla «¿Dónde va a trabajar hoy?». Los módulos se muestran **según los permisos** de `/auth/me` (la ausencia oculta, no deshabilita).
- **Pantallas:** inicio de sesión y elección de contexto; **Hoy** (cifras y próximas citas); **Agenda** diaria (columnas por odontólogo, ventanas de atención, bloqueos) y semanal (lista por día, equivalente accesible), filtros de sede/odontólogo, nueva cita (buscador de pacientes tipo combobox, horarios libres), reprogramar, cancelar y ausencia con motivo, confirmar, iniciar atención; **Pacientes** (búsqueda y ficha resumida con citas); **Ficha de atención** (alertas, alergias, consentimiento, diagnósticos, procedimientos, evolución, resumen del odontograma; solo lectura); **Odontograma** (dibujo SVG del servidor, tabla equivalente accesible, descarga del PDF por petición autenticada, aviso «formato clínico por validar»).
- **Privacidad:** sin UUID, hash ni mensajes de infraestructura en pantalla (errores 5xx → texto genérico + código de soporte); sin datos personales en la URL (solo ids internos); sin recursos de terceros; descargas como *blob* autenticado; no se guarda nada clínico en el navegador.
- **Pruebas** (Vitest + Testing Library con API simulada): inicio de sesión (contexto único y múltiple, error genérico, token fuera de `localStorage`), agenda, creación de cita (incl. conflicto), cancelación con motivo, inicio de atención, **acceso denegado a datos clínicos para recepción** (ni se muestran ni se solicitan), cliente (renovación serializada, mensajes 5xx/429).

### Desarrollo y despliegue
`npm run db:up && npm run db:migrate && npm run db:seed`, `npm run api:dev` y `npm run admin:dev` (http://localhost:5173/admin/). Vite reenvía `/v1` a la API (`API_URL`, por defecto `http://127.0.0.1:3000`) para que cookie y CSRF funcionen en el mismo origen; `CORS_ORIGINS` debe incluir el origen del panel (en desarrollo `http://localhost:5173`; si 5173 está ocupado, Vite usa otro puerto y hay que agregarlo). En producción, Nginx sirve `apps/admin/dist` en `/admin/` y reenvía `/v1` a la API **en el mismo host** (ver `deploy/nginx/apidental.conf.example`); `CORS_ORIGINS` debe incluir `https://dental.apiworking.com.pe`. No se desplegó nada.

## 4. Datos de demostración (ficticios)
`npm run db:seed` agrega consultorios, servicio, horario de la odontóloga demo (todos los días 08:00–18:00, solo para la demostración) y seis citas: **hoy, Camila Demo Nueva** (sin visitas, lista para «Iniciar atención»), Lucía (confirmada), Mateo, Jorge, una cancelada y una ausencia de ayer. Cuentas: `recepcion.demo@apidental.test` (agenda, sin acceso clínico), `odontologa.demo@apidental.test` (atiende y ve ficha/odontograma). Idempotente.

## 5. Decisiones a confirmar y riesgos
- Vigencia de la relación por cita: fin + 30 días **[por validar]**. Ventana de inicio de atención (−30 min / +6 h) y paso de oferta de 15 min: configurables en código, no por clínica.
- Sin recordatorios ni mensajería: la confirmación es manual.
- Un paciente no puede tener dos citas activas superpuestas; una cita no cruza la medianoche.
- Bloqueo máximo de 14 días por registro; consulta de agenda máx. 31 días.
- Pendiente: cierre por inactividad con difuminado de pantalla (sistema de diseño §9), pruebas automatizadas de accesibilidad (`axe`) y revisión manual con lector de pantalla, edición de diagnósticos/procedimientos/evolución desde el panel (la ficha es de solo lectura), pantallas de configuración de la agenda (hoy se configura por API), arrastrar para reprogramar (hay botón).
- Condiciones previas a datos reales (sin cambios): canal de entrega probado, respaldo diario externo con restauración verificada, cifrado de volumen/respaldos y gestión de secretos, revisión legal.
