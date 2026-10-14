# ApiDental: Propuesta de implementación MVP P0 (Clínica Demo)

Estado: borrador para validación. Sin cambios de código asociados.
Convención: lo marcado **[por validar]** no es un hecho; es una propuesta o supuesto que depende de Apiworking, de normativa vigente o de una decisión pendiente.

---

## 1. Confirmaciones, supuestos, riesgos y preguntas abiertas

### 1.1 Confirmado (según el brief del producto)
- Stack: React + Vite (panel en `/admin`), Next.js (sitio público), NestJS, MySQL, Prisma. Monolito modular; sin microservicios en P0.
- Producción: VPS Debian sin Docker, Nginx con TLS, despliegue manual por SSH y Git. Docker solo para pruebas locales.
- Dominios: `dental.apiworking.com.pe` (sitio en `/`, panel en `/admin`) y `api.dental.apiworking.com.pe` (API).
- ApiDental es fuente de verdad clínica y operativa. Apiworking lo es de comprobantes y estado SUNAT, fidelización (APILoyalty) y métricas NFC (ApiReview).
- Autenticación basada en JWT; sin 2FA en el MVP.
- Idioma es-PE, moneda PEN, zona horaria `America/Lima`.
- No se envía información clínica a Apiworking. Toda solicitud de comprobante y evento de fidelización lleva clave de idempotencia.
- Los contratos de Apiworking aún no han sido entregados. Los webhooks no están confirmados.
- Backup mínimo cada tres días (MySQL y archivos) con copia externa al VPS.
- Conservación indefinida de la historia clínica como decisión comercial actual.

### 1.2 Supuestos (reversibles)

| # | Supuesto | Reversión |
|---|---|---|
| S1 | Multi-tenant por columna `clinic_id` en una sola base. | Instalación por clínica = misma base con una sola clínica. |
| S2 | El JWT para hablar con Apiworking se trata como credencial de servicio por clínica, guardada cifrada. **[por validar]**: Apiworking indicó JWT "asociado al inicio de sesión", pero no se sabe si es por usuario, clínica o sede, ni su vigencia o renovación. | Capa `ApiworkingClient` aislada tras una interfaz. |
| S3 | Access token corto (15 min) y refresh token rotativo en cookie `HttpOnly`, `Secure`, `SameSite=Lax`. | Parámetros de configuración. |
| S4 | Cola de reintentos en tabla MySQL (outbox) con worker en el proceso NestJS, sin Redis. | Migrable a BullMQ. |
| S5 | Odontograma almacenado como JSON versionado, renderizado SVG, exportación a PDF. | El esquema se ajusta tras validar el formato MINSA. |
| S6 | Una cita pertenece a una sede, un odontólogo y un consultorio; la especialidad proviene del servicio. | |
| S7 | El paciente pertenece a la clínica (no a la sede); las sedes comparten historia. | |
| S8 | API gestionada con `systemd`; el sitio Next.js bajo `systemd` o export estático si no requiere SSR. | |
| S9 | Adjuntos en disco privado con nombre UUID, hash SHA-256 y descarga solo vía API autorizada. | |
| S10 | Exportación de datos como job manual disparado por Administrador de clínica o de plataforma. | |
| S11 | La reautenticación con contraseña para confirmar el cierre de una evolución **no** constituye firma legal ni digital. | Firma manuscrita o digital queda en P1 si se valida como necesaria. |

### 1.3 Riesgos
1. **Contratos de Apiworking ausentes.** Bloquea la integración real de facturación. Mitigación: interfaz `BillingProvider` y un mock; desarrollar y probar contra el mock.
2. **Normativa por validar.** Formato MINSA de odontograma e historia clínica, conservación indefinida, protección de datos personales y condiciones SUNAT no están validados. No se afirma cumplimiento hasta una revisión con asesor competente.
3. **Respaldo cada 3 días es insuficiente para historias clínicas en producción.** Se mantiene solo como mínimo temporal. Ver sección 8.6.
4. **Despliegue manual en VPS único.** Punto único de falla y riesgo de error humano. Mitigación: script de despliegue versionado, checklist, respaldo previo a cada migración, plan de rollback.
5. **Duplicidad de comprobantes por reintentos.** Mitigación: idempotencia persistida antes del primer envío y máquina de estados estricta.
6. **Fuga de datos clínicos hacia Apiworking.** Mitigación: DTO de salida con lista blanca y nunca serializar entidades directamente; riesgo adicional si la clínica pone texto clínico en el nombre de un servicio.
7. **Deduplicación de pacientes** (DNI faltante, celular compartido). Mitigación: alertas de posible duplicado, sin fusión automática.
8. **JWT sin 2FA en datos clínicos.** Mitigación: bloqueo por intentos, política de contraseñas, sesiones cortas, auditoría; recomendar 2FA en P1.
9. **Odontograma "adecuado a MINSA"** puede requerir rediseño si el formato oficial exige campos no previstos.
10. **Confusión entre reautenticación y firma.** Mitigación: terminología y avisos en UI (ver 6.4).

### 1.4 Preguntas abiertas
Ver la sección final **"Decisiones que requieren validación"**, que consolida las preguntas críticas y no críticas.

---

## 2. Alcance P0

### 2.1 Incluido
- Autenticación, roles y permisos por clínica, sede y módulo.
- Multi-clínica y multi-sede con branding por clínica (logo y colores).
- Pacientes: datos, contacto, antecedentes, alergias, alertas, detección de posibles duplicados.
- Historia clínica: visitas, diagnósticos, tratamientos realizados y evolución. Append-only, con correcciones versionadas.
- Adjuntos clínicos (radiografías, fotos, documentos) y consentimientos cargados como PDF o imagen.
- Odontograma digital visual, versionado y exportable en PDF para el paciente.
- Agenda: disponibilidad, citas con los 5 estados (reservado, confirmado, atendido, cancelado, ausente) y seguimiento de ausencias.
- Especialidades y servicios configurables (iniciales: odontología general, ortodoncia, endodoncia, odontopediatría).
- Pagos parciales, adelantos, mixtos, saldos y cuentas por cobrar. Medios referenciales: efectivo, Yape, Plin, transferencia, POS/tarjeta, crédito.
- Caja con apertura y cierre; operaciones críticas auditadas.
- Comprobantes vía Apiworking: solicitud, estados locales, cola de reintentos, pantalla de conciliación, anulación o nota de crédito.
- Inventario básico de productos de venta: stock, movimientos, ventas, alerta de mínimo.
- Auditoría de lectura y modificación clínica y de operaciones críticas de caja.
- Respaldos, exportación de datos de clínica (ZIP con Excel), sitio público Next.js.
- Reportes propios mínimos: cobros del día, saldos por cobrar, citas por estado, stock bajo.

### 2.2 Excluido de P0
- Presupuestos, planes de tratamiento, cuotas y aceptación (P1).
- Comisiones, consumo de materiales por procedimiento, integración APILoyalty (P1).
- Firma manuscrita o digital (P1, si se valida como necesaria).
- Lotes, vencimientos, compras, resumen NFC ApiReview, IA administrativa (P2).
- Recordatorios por WhatsApp o SMS: solo se prepara la arquitectura (`notification_outbox`, interfaz `NotificationChannel`); sin proveedor asumido.
- Pagos en línea, app móvil nativa, 2FA, microservicios, webhooks de Apiworking (se proponen, no se asumen).
- El odontograma no genera tratamientos ni presupuestos automáticos.

### 2.3 Preparación para P1
El modelo incluye desde P0 los consentimientos separados (clínico, fidelización, marketing) y una cola de eventos genérica, para no rehacerlos al integrar APILoyalty.

---

## 3. Arquitectura, módulos, rutas y despliegue

```
 Navegador
    │ HTTPS
    ▼
 Nginx (TLS)
    ├─ dental.apiworking.com.pe/        → Next.js (sitio público)
    ├─ dental.apiworking.com.pe/admin   → estáticos Vite (base: '/admin/')
    └─ api.dental.apiworking.com.pe     → NestJS (127.0.0.1:<puerto>)
                                              │
                         MySQL (localhost)  ◄─┤
                         Disco privado de adjuntos (fuera del webroot)
                                              │
                          Worker outbox ──► Apiworking (HTTPS)
```

### 3.1 Estructura de repositorio (propuesta)
```
apps/api         NestJS
apps/admin       React + Vite (base /admin/)
apps/web         Next.js
packages/shared  tipos y esquemas de validación compartidos
deploy/          configuración Nginx, unidades systemd, scripts de deploy y backup
docs/            documentación de arquitectura
```

### 3.2 Módulos NestJS
`auth`, `tenancy` (clínica/sede), `users-roles`, `patients`, `clinical-records`, `odontogram`, `attachments`, `scheduling`, `catalog`, `payments`, `billing` (adaptador Apiworking + outbox), `inventory`, `audit`, `reports`, `data-export`, `notifications` (solo interfaz). Los módulos se comunican por servicios exportados, no accediendo a tablas ajenas.

### 3.3 Rutas del panel (`/admin/...`)
`/login`, `/agenda`, `/pacientes`, `/pacientes/:id` (resumen, historia, odontograma, adjuntos, pagos), `/caja`, `/cobros`, `/comprobantes` (incluye conciliación), `/inventario`, `/reportes`, `/configuracion` (clínica, sedes, usuarios, servicios), `/auditoria`.

### 3.4 Separación de frontends
- Sitio Next.js: SEO, metadatos, sitemap, contenido comercial, captación y enlace a `/admin`. Sin datos clínicos ni lógica operativa.
- Panel React/Vite: protegido por autenticación, responsive, consume exclusivamente la API NestJS.

### 3.5 Despliegue manual en VPS
- Usuario Unix dedicado, MySQL solo en localhost, firewall (22, 80, 443).
- API como unidad `systemd`. Script `deploy.sh`: `git pull` en tag, `npm ci`, build, `prisma migrate deploy`, reinicio, verificación de salud.
- Respaldo previo a cada migración y plan de rollback (tag anterior + dump).
- Nginx: `client_max_body_size` acorde a radiografías, cabeceras de seguridad, CORS restringido a `dental.apiworking.com.pe`.
- Cookie de refresh emitida por `api.dental...` con el panel en otro host: ambos comparten sitio registrable (`apiworking.com.pe`), por lo que `SameSite=Lax` debería funcionar. **[por validar en pruebas]**.

---

## 4. Modelo de dominio y entidades principales

Conceptual; sin SQL. Toda tabla de negocio lleva `clinic_id`, `created_at`, `updated_at`, `created_by`.

**Tenancy y acceso**
- `Clinic` (nombre, branding, RUC, configuración), `Branch` (sede), `Room` (consultorio).
- `User`, `Role`, `Permission`, `UserAssignment` (usuario ↔ clínica ↔ sede ↔ rol). Un odontólogo en varias clínicas o sedes requiere asignaciones explícitas.
- `Dentist` (perfil profesional: colegiatura, especialidades), vinculado a `User`.

**Pacientes**
- `Patient` (`patient_id` interno, inmutable, generado por ApiDental), `PatientIdentifier` (tipo, valor, vigencia, historial), `PatientContact` (celular, correo, dirección; sin unicidad), `Guardian` (apoderado).
- `PatientConsent` (tipo: clínico / fidelización / marketing; estado; fecha; adjunto; revocación).
- `MedicalBackground`, `Allergy`, `ClinicalAlert`.

**Clínico**
- `Visit` (paciente, sede, odontólogo, cita opcional).
- `ClinicalEntry` (diagnóstico, procedimiento, evolución), append-only: una corrección crea una versión nueva con `supersedes_id` y motivo. Sin DELETE en la capa de servicio ni en permisos de BD.
- `Odontogram` y `OdontogramVersion` (JSON con estado por pieza y superficie, versión de esquema, fecha, autor).
- `Attachment` (tipo, ruta privada, hash, tamaño, MIME validado, paciente, visita opcional; baja lógica con motivo).

**Agenda**
- `Specialty`, `Service` (especialidad, duración, precio referencial).
- `DentistSchedule`, `ScheduleException`.
- `Appointment`, `AppointmentStatusLog`, `NoShowFollowUp`.

**Pagos y caja**
- `CashRegister`, `CashSession` (apertura, cierre, arqueo).
- `Charge` (consulta, tratamiento o venta; total; saldo) y `ChargeItem`.
- `Payment` con `PaymentLine` (medio, monto, referencia) para pagos mixtos; `PaymentAllocation` para aplicar pagos y adelantos a cargos. Crédito = saldo pendiente del `Charge`.
- `Voucher` (`charge_id`, tipo, serie y número recibidos de Apiworking, `status` local, `idempotency_key`, `external_ref`, `last_error`).
- `OutboxEvent` (tipo, payload mínimo, `idempotency_key`, estado, intentos, `next_attempt_at`) y `ReconciliationCase`.

**Inventario**
- `Product`, `StockLevel` (por sede), `StockMovement` (entrada, venta, ajuste con motivo).
- La venta de producto es un `Charge` con `ChargeItem` hacia producto.

**Transversales**
- `AuditLog` (usuario, acción, entidad, `patient_id`, sede, IP, fecha, resumen de cambio; solo inserción).
- `ExportJob`, `Notification`, `NotificationTemplate` (preparación).

**Reglas de dominio**
- Montos en decimal exacto, nunca float.
- Un `Charge` pagado, cancelado o con comprobante emitido no se edita: se corrige con ajuste o nota de crédito.
- Estados locales de `Voucher` (propuestos): `PENDIENTE_ENVIO`, `ENVIADO`, `EMITIDO`, `RECHAZADO`, `ERROR_REINTENTABLE`, `REQUIERE_CONCILIACION`, `ANULACION_PENDIENTE`, `ANULADO`, `NOTA_CREDITO_EMITIDA`. Son estados **locales de ApiDental**; su mapeo con los estados reales de Apiworking/SUNAT **[por validar]**.

---

## 5. Matriz de roles y permisos

L = leer, E = crear/editar, A = anular/cerrar, — = sin acceso. Todo permiso se aplica dentro de las clínicas y sedes asignadas.

| Módulo | Admin plataforma | Admin clínica | Recepción | Odontólogo | Cajero | Asistente |
|---|---|---|---|---|---|---|
| Clínicas, sedes, branding | L/E | L/E (la propia) | — | — | — | — |
| Usuarios y roles | L/E | L/E (su clínica) | — | — | — | — |
| Pacientes (datos demográficos) | L* | L/E | L/E | L | L | L |
| Historia clínica y evoluciones | — (solo acceso excepcional auditado) | **[política por validar]** | — | L/E (pacientes y sedes con relación asistencial) | — | L (limitado) |
| Odontograma | — | **[política por validar]** | — | L/E | — | L |
| Adjuntos clínicos | — | **[política por validar]** | — | L/E | — | L/E (cargar) |
| Consentimientos (carga) | — | L/E | E | L/E | — | E |
| Agenda y citas | — | L/E | L/E | L/E (propias) | L | L |
| Catálogo (servicios, especialidades) | — | L/E | L | L | L | L |
| Cobros y pagos | — | L/E/A | L (saldo) | L (de sus atenciones) | L/E | — |
| Caja (apertura y cierre) | — | L/A | — | — | L/E/A | — |
| Comprobantes y conciliación | — | L/E/A | L | — | L/E | — |
| Inventario | — | L/E | L | — | L/E (ventas) | L/E (movimientos) |
| Reportes | L (agregados) | L | Limitados | Propios | Caja | — |
| Auditoría | L | L | — | — | — | — |
| Exportación de datos | E | E | — | — | — | — |

\* Admin de plataforma: acceso a datos demográficos mínimo necesario para soporte, auditado. **[por validar]**

Notas:
- El Administrador de plataforma no debería ver datos clínicos por defecto. Si el soporte lo requiere, debe ser con acceso temporal, justificado y auditado. **[por validar]**
- Acceso del Administrador de clínica a historias clínicas: propuesta de partida = solo lectura auditada, con motivo. **[política por validar con Clínica Demo y asesor normativo]**
- El Odontólogo accede a pacientes con relación asistencial (cita o visita en su sede). Se evalúa un "acceso de emergencia" con motivo obligatorio y auditoría.
- El Asistente no edita evoluciones; solo carga adjuntos y ve alertas.
- Permisos modelados como `modulo:accion`; los roles son plantillas editables por el Admin de clínica dentro de límites.

---

## 6. Flujos de usuario

### 6.1 Paciente
Recepción busca por DNI, celular o nombre → si no existe, crea → el sistema alerta de posibles duplicados y no fusiona automáticamente → se registran consentimiento clínico (carga de PDF o foto), antecedentes, alergias y alertas (visibles en la cabecera de toda pantalla clínica). El cambio de DNI o celular exige motivo y queda auditado.

### 6.2 Cita
Selección de sede, especialidad/servicio, odontólogo y horario → validación de choques por odontólogo y consultorio → `reservado` → `confirmado` (confirmación manual en P0) → `atendido` | `ausente` | `cancelado` (con motivo). La reprogramación conserva historial. Una ausencia genera una tarea de seguimiento con resultado (contactado, reagendó, sin respuesta).

### 6.3 Atención clínica
El odontólogo abre la cita → ve alertas, alergias, última evolución y odontograma → registra diagnóstico, procedimiento y evolución → **reautenticación para confirmar el cierre de la evolución** → la entrada queda bloqueada → una corrección crea una versión nueva con motivo y la anterior sigue visible → adjunta radiografías → marca la visita como atendida y se generan los conceptos por cobrar.

### 6.4 Reautenticación vs. firma
La reautenticación con contraseña confirma que quien cierra la evolución es la persona autenticada y deja evidencia en auditoría. **No es una firma clínica, legal ni digital** y la UI no debe llamarla "firma". Si se requiere firma manuscrita o digital con validez, se evalúa en P1. **[por validar]**

### 6.5 Odontograma
Abrir el odontograma vigente (o crear el inicial) → marcar estado por pieza y superficie con catálogo de símbolos → guardar como nueva versión (nunca sobrescribe) → comparar versiones → exportar PDF para el paciente. Hasta validar el formato MINSA, el PDF no se presenta como "formato MINSA". No genera tratamientos ni presupuestos.

### 6.6 Pago
El cajero abre sesión de caja → selecciona el cargo o crea una venta → registra pago total, parcial o adelanto, pudiendo combinar medios → el saldo se recalcula → un cargo a crédito queda como cuenta por cobrar → cierre de caja con arqueo y diferencias. Anular un pago exige permiso, motivo y auditoría.

### 6.7 Comprobante
Con el cobro registrado, se elige tipo de comprobante y datos del cliente → se crea `Voucher` en `PENDIENTE_ENVIO` y un `OutboxEvent` con clave de idempotencia **en la misma transacción** → el worker envía → según la respuesta, `EMITIDO` o `RECHAZADO` → ante error de red, `ERROR_REINTENTABLE` y reintento → tras N intentos, pasa a la bandeja de conciliación. El cobro nunca se pierde por una falla externa.

### 6.8 Inventario
Alta de producto con stock inicial (movimiento "entrada") → la venta descuenta stock en la misma transacción del cobro → ajustes manuales con motivo → alerta al llegar al mínimo → venta sin stock suficiente: bloqueo por defecto, con permiso de excepción configurable.

---

## 7. Contrato sugerido de facturación con Apiworking

> Todo lo siguiente es una **propuesta para negociar**. No hay endpoints, campos, autenticación ni estados confirmados. Los nombres son ilustrativos.

**Propósito.** Solicitar la emisión de un comprobante electrónico por un cobro de ApiDental y obtener su estado.

**Datos mínimos enviados (lista blanca)**
- Identificadores de clínica, sede y `patient_id` interno (opaco).
- Cliente del comprobante: tipo y número de documento, nombre o razón social, dirección si aplica.
- Tipo de comprobante **[por validar según SUNAT y Clínica Demo]**.
- Ítems con descripción comercial genérica, cantidad, precio e impuestos según corresponda.
- Montos, moneda PEN, forma(s) de pago, fecha de emisión y `idempotency_key`.
- **Nunca**: diagnóstico, tratamiento detallado, odontograma, historia clínica ni adjuntos. La UI debe advertir si el nombre de un servicio parece contener información clínica.

**Idempotencia.** La clave es un UUID creado una vez por `Voucher`, persistido antes del primer envío y reutilizado en todos los reintentos. Se solicita a Apiworking que, ante la misma clave, devuelva el resultado original sin emitir otro comprobante. Si Apiworking no lo garantiza, se cambia el diseño (consulta previa por referencia antes de reenviar). **[por validar; condición de salida del contrato]**

**Respuesta esperada (a acordar).** Aceptación o rechazo; serie y número; estado SUNAT; referencia externa; motivo de rechazo; enlace o representación del documento. Debe distinguirse "recibido, en proceso" de "emitido".

**Estados locales.** Ver sección 4. El mapeo con los estados de Apiworking **[por validar]**.

**Reintentos.** Backoff exponencial con jitter y máximo configurable. Se reintentan errores de red, timeout y 5xx. Un rechazo funcional no se reintenta: pasa a `RECHAZADO`, se corrige y se crea una nueva solicitud con nueva clave. Ante un timeout ambiguo, antes de reenviar se consulta el estado por clave o referencia, si el contrato lo permite.

**Conciliación manual.** Pantalla `/admin/comprobantes` con filtros por estado, antigüedad y sede. Acciones: reintentar, corregir y reenviar, vincular manualmente un comprobante emitido por fuera, marcar como resuelto con motivo. Todo auditado. Un job periódico consulta estados antiguos en `ENVIADO`.

**Webhook sugerido (mejora a solicitar, no confirmada).** Notificación de cambio de estado, firmada (HMAC) y con idempotencia propia. Mientras no exista, se usa consulta periódica.

**Anulación / nota de crédito.** ApiDental solicita (motivo, comprobante de referencia, monto, clave de idempotencia propia) → `ANULACION_PENDIENTE` → Apiworking emite → `ANULADO` o `NOTA_CREDITO_EMITIDA`. Localmente se genera el ajuste de caja correspondiente. Reglas y plazos SUNAT: **[por validar]**.

**Trazabilidad.** Cada llamada registra clave, código de respuesta, tiempo y resumen sin datos sensibles, enlazado al `Voucher`.

**Esbozo para P1** (solo referencia): evento de fidelización con clave de idempotencia por evento; consulta de saldo y beneficios en tiempo real con degradación elegante; lectura de resumen NFC solo lectura. Un toque NFC no equivale a reseña publicada, y ningún punto, descuento o premio se condiciona a una reseña en Google.

---

## 8. Autenticación, autorización, auditoría, adjuntos y respaldos

### 8.1 Autenticación
- Login con correo y contraseña; hash Argon2id; política de contraseñas; bloqueo progresivo por intentos fallidos.
- JWT de acceso de corta vida (propuesta: 15 min) y refresh token rotativo, guardado con hash en BD, revocable por sesión y enviado en cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
- Cierre de sesión por inactividad en el panel; recuperación y cambio de contraseña con flujo de enlace de un solo uso.
- **Reautenticación para confirmar el cierre de la evolución:** el odontólogo reingresa su contraseña; se emite una confirmación de corta vida asociada a esa acción y queda en auditoría. No es una firma clínica, legal ni digital (ver 6.4).
- Sin 2FA en el MVP; se recomienda evaluarlo en P1.
- El JWT que ApiDental use contra Apiworking es un asunto distinto del JWT de sus propios usuarios, y su naturaleza **[por validar con Apiworking]**. Las credenciales hacia Apiworking se guardan cifradas, nunca en el repositorio.

### 8.2 Autorización
- Cadena de guards en NestJS: autenticación → permiso del módulo → alcance (clínica y sede) → relación asistencial para datos clínicos.
- El `clinic_id` nunca se toma del cliente: se deriva de las asignaciones del usuario autenticado. Un filtro obligatorio a nivel de Prisma lo aplica en cada consulta, con pruebas automatizadas de aislamiento entre clínicas.
- Las reglas de acceso del Administrador de clínica a datos clínicos se implementan como política configurable, con el valor por defecto más restrictivo hasta que se defina. **[por validar]**

### 8.3 Auditoría
- Se registran: lectura de historia, odontograma y adjuntos (usuario, paciente, sede, fecha, IP); toda modificación clínica (valor previo y nuevo, resumidos); reautenticaciones de cierre; operaciones de caja (apertura, cierre, anulaciones, descuentos); ajustes de stock; cambios de permisos; exportaciones.
- Tabla de solo inserción: el usuario de BD de la aplicación no tiene UPDATE ni DELETE sobre ella.
- Consultable por el Administrador con filtros. Retención indefinida acorde a la decisión comercial actual, **[por validar normativamente]**.

### 8.4 Adjuntos
- Almacenados en disco privado fuera del webroot, con nombre UUID. Nginx no sirve ese directorio.
- Descarga solo mediante la API, con autorización y registro de auditoría.
- Validación del tipo por contenido (no solo por extensión), límite de tamaño, hash SHA-256 y cabeceras de descarga seguras. Antivirus (p. ej., ClamAV) como mejora opcional según recursos del VPS.
- Cifrado en reposo del volumen o directorio: recomendado; decisión pendiente según el VPS.
- Sin borrado físico por usuarios: la baja es lógica, con motivo y auditada.

### 8.5 Exportación de datos al terminar el servicio (ZIP con Excel)
- **Incluir:** clínica y sedes; usuarios (sin hashes de contraseña); pacientes, identificadores y contactos; antecedentes, alergias y alertas; visitas; entradas clínicas con todo su historial de versiones; odontogramas (versiones y PDF); citas; consentimientos (estado y archivo); cargos, pagos y caja; comprobantes (estado, serie, número, referencia externa); inventario y movimientos; catálogo de servicios; índice de adjuntos.
- **Adjuntos:** archivos originales en carpetas por paciente, con un Excel índice (nombre, fecha, tipo, hash) para verificar integridad.
- **Excluir:** contraseñas, tokens, credenciales de Apiworking. La auditoría técnica se incluye solo si la clínica la solicita. **[por validar]**
- Solo personal autorizado; generación asíncrona; enlace temporal; ZIP protegido; registro en auditoría.

### 8.6 Respaldos
- **Mínimo temporal** (según el brief): MySQL y archivos cada 3 días, con copia externa al VPS. Se acepta únicamente para desarrollo y pruebas, o como arranque transitorio del piloto.
- **Recomendación para producción con historias clínicas:** respaldo **diario** de MySQL y de archivos adjuntos, con **copia externa cifrada**, retención escalonada (diaria, semanal, mensual), y alerta si un respaldo falla.
- **Pruebas periódicas de restauración** (propuesta: al menos trimestrales y antes del paso a producción), documentadas, verificando integridad de la base y de los adjuntos.
- Respaldo previo a cada despliegue con migración.
- Las claves de cifrado de los respaldos se guardan fuera del VPS.
- Estrategia de destino externo (proveedor, ubicación, costo): **[por validar]**.

---

## 9. Backlog P0 priorizado

Prioridad por dependencia. CA = criterios de aceptación.

### Épica A. Fundaciones
- **A1. Multi-clínica y sedes.** Como Admin de plataforma, creo clínicas y sedes con branding. *CA:* una clínica no ve datos de otra (prueba automática); logo y colores se reflejan en el panel.
- **A2. Login y sesiones.** Como usuario, inicio sesión de forma segura. *CA:* bloqueo tras N intentos; refresh rotativo; logout invalida la sesión; expiración por inactividad.
- **A3. Roles y permisos.** Como Admin de clínica, asigno roles por sede. *CA:* cada rol accede solo a lo permitido por la matriz; un odontólogo opera solo en sedes asignadas; pruebas por rol.
- **A4. Auditoría base.** Como Admin, consulto quién accedió y modificó. *CA:* lecturas y escrituras clínicas generan registro; la tabla no admite UPDATE/DELETE desde la aplicación.

### Épica B. Pacientes
- **B1. Alta y búsqueda.** *CA:* `patient_id` generado e inmutable; búsqueda por DNI, celular y nombre; celular repetido permitido.
- **B2. Alerta de duplicados.** *CA:* aviso con coincidencias; sin fusión automática.
- **B3. Cambio de DNI o celular.** *CA:* exige motivo; queda historial auditado.
- **B4. Antecedentes, alergias y alertas.** *CA:* las alertas se muestran en la cabecera de toda pantalla clínica.
- **B5. Consentimientos.** *CA:* carga de PDF o imagen; tres tipos separados; revocar no borra el registro.

### Épica C. Historia clínica y adjuntos
- **C1. Visita y evolución.** *CA:* entrada vinculada a visita y odontólogo; el cierre exige reautenticación y la deja inmutable.
- **C2. Corrección versionada.** *CA:* corregir crea una versión nueva con motivo; la anterior se conserva y es visible; no existe eliminación física.
- **C3. Adjuntos.** *CA:* subida validada; descarga solo con permiso; la URL directa al archivo no es accesible; cada acceso queda auditado.

### Épica D. Odontograma
- **D1. Odontograma visual.** *CA:* marcar por pieza y superficie; usable en tablet.
- **D2. Versiones.** *CA:* cada guardado crea versión; historial y comparación disponibles.
- **D3. Exportación PDF.** *CA:* incluye datos de paciente, clínica, fecha y odontólogo; no crea tratamientos ni presupuestos; sin afirmar cumplimiento MINSA mientras no se valide.

### Épica E. Agenda
- **E1. Disponibilidad.** *CA:* horarios por odontólogo y sede; excepciones y feriados.
- **E2. Crear y reprogramar citas.** *CA:* sin choques de odontólogo ni consultorio; la reprogramación conserva historial.
- **E3. Estados y cancelación.** *CA:* los 5 estados con transiciones válidas; cancelar exige motivo.
- **E4. Seguimiento de ausencias.** *CA:* una ausencia crea tarea de seguimiento con resultado.
- **E5. Calendario.** *CA:* filtros por odontólogo, sede, consultorio y especialidad.

### Épica F. Catálogo
- **F1. Especialidades y servicios.** *CA:* 4 especialidades precargadas; la clínica agrega propias; duración y precio por servicio.

### Épica G. Cobros y caja
- **G1. Registrar cobro.** *CA:* total, parcial y adelanto; saldo correcto; montos decimales exactos.
- **G2. Pago mixto.** *CA:* la suma de medios iguala el pago; cada línea conserva su medio.
- **G3. Cuentas por cobrar.** *CA:* listado de deudores con antigüedad; pagos posteriores se aplican al saldo.
- **G4. Caja.** *CA:* apertura y cierre con arqueo; un cobro exige sesión abierta; la anulación exige permiso y motivo.

### Épica H. Comprobantes
- **H1. Puerto `BillingProvider` y mock.** *CA:* el flujo completo funciona contra el mock, incluyendo fallos simulados.
- **H2. Outbox con idempotencia.** *CA:* la clave se persiste antes del envío; el reintento la reutiliza; una prueba de reintentos no genera un segundo comprobante.
- **H3. Estados visibles.** *CA:* el cobro se guarda aunque Apiworking esté caído; el estado del comprobante se ve en el cobro.
- **H4. Reintentos con backoff.** *CA:* errores transitorios se reintentan; rechazos funcionales no.
- **H5. Conciliación.** *CA:* filtros; reintento manual; vinculación manual; resolución con motivo; todo auditado.
- **H6. Anulación / nota de crédito.** *CA:* solicitud con clave propia; estado intermedio; ajuste local coherente.
- **H7. Integración real con Apiworking.** Depende del contrato. *CA:* pruebas de contrato en entorno de pruebas y verificación de que ningún dato clínico aparece en payloads ni logs.

### Épica I. Inventario
- **I1. Productos y stock por sede.**
- **I2. Venta con descuento de stock.** *CA:* en la misma transacción del cobro; no baja de cero salvo excepción autorizada.
- **I3. Ajustes y movimientos con motivo.**
- **I4. Alerta de stock mínimo.**

### Épica J. Reportes, exportación y plataforma
- **J1. Reportes mínimos** (cobros, saldos, citas, stock).
- **J2. Exportación ZIP/Excel.** *CA:* contiene lo listado en 8.5; asíncrona; auditada.
- **J3. Respaldos automatizados y prueba de restauración.** *CA:* respaldo diario externo operativo; restauración probada y documentada.
- **J4. Sitio público Next.js.** *CA:* SEO, sitemap, metadatos, páginas comerciales, enlace a `/admin`; sin datos clínicos.
- **J5. Despliegue.** *CA:* script de deploy, Nginx, systemd y runbook funcionando en el VPS.

---

## 10. Plan de implementación por fases y orden de desarrollo

Las duraciones son estimaciones gruesas para un equipo pequeño y no un compromiso; dependen de la dedicación y de cuándo se entreguen los contratos y validaciones externas.

| Fase | Contenido | Resultado verificable |
|---|---|---|
| **0. Preparación** (1–2 sem.) | Monorepo, entornos, Prisma, esquema de tenancy, resolución de decisiones críticas, solicitud formal del contrato a Apiworking, inicio de validación normativa. | Proyecto arranca; pruebas de aislamiento por clínica. |
| **1. Núcleo** (2–3) | A1–A4, F1, base del panel (layout, branding, login). | Login por rol y auditoría activa. |
| **2. Pacientes e historia** (3–4) | B1–B5, C1–C3. | Historia versionada y adjuntos privados. |
| **3. Agenda** (2–3) | E1–E5. | Flujo completo de cita. |
| **4. Odontograma** (2–3) | D1–D3. El esquema final depende de la validación MINSA. | Exportación PDF. |
| **5. Cobros y caja** (3) | G1–G4. | Cobro, saldos y cierre de caja. |
| **6. Comprobantes** (3–4) | H1–H6 contra el mock; H7 cuando exista contrato. | Flujo resiliente sin duplicados; conciliación. |
| **7. Inventario** (2) | I1–I4. | Venta con descuento de stock. |
| **8. Cierre de P0** (2–3) | J1–J5, endurecimiento de seguridad, ensayo de restauración. | Listo para el piloto. |
| **9. Piloto Clínica Demo** (2–4) | Carga inicial, capacitación, operación asistida, ajustes. | Uso real supervisado. |

**Orden de desarrollo y razones**
1. Tenancy, auth y auditoría primero: todo lo demás depende del aislamiento por clínica y de los permisos.
2. Pacientes e historia antes que agenda: la cita referencia al paciente y la visita.
3. Cobros antes que comprobantes: el comprobante nace de un cobro y debe funcionar sin Apiworking.
4. El mock de facturación permite avanzar sin el contrato real; la integración real (H7) se hace al final de la fase 6.
5. Inventario después de cobros, porque la venta de productos reutiliza el flujo de `Charge`.

**Puntos de decisión**
- Fin de fase 0: aceptación del contrato por Apiworking o contrapropuesta.
- Fin de fase 4: validación del odontograma con un odontólogo de Clínica Demo y asesor normativo.
- Antes del piloto: revisión de datos personales y consentimientos, respaldo diario externo operativo y restauración probada.

---

## 11. Decisiones que requieren validación

| # | Decisión | Por qué importa | Bloquea | Responsable sugerido |
|---|---|---|---|---|
| 1 | **Contrato real de Apiworking, credenciales y estrategia de idempotencia.** Qué autenticación se usa realmente (el JWT es solo una intención declarada), con qué alcance (usuario, clínica, sede), vigencia y renovación; si Apiworking garantiza resultado idempotente por clave; si hay consulta de estado por clave o referencia; si habrá webhooks. | Define el adaptador, el manejo de timeouts ambiguos y la prevención de duplicados. | Fase 6 (H7) | Apiworking |
| 2 | **Formato y requisitos vigentes MINSA** para odontograma e historia clínica (campos, simbología, conservación, firmas). | El modelo de odontograma y de historia puede cambiar; no se debe afirmar cumplimiento sin esto. | Fases 2 y 4 | Asesor normativo / Clínica Demo |
| 3 | **Tipos de comprobante y condiciones SUNAT** aplicables a Clínica Demo (tipos, régimen, notas de crédito/anulación, plazos). | Afecta los datos requeridos, el flujo de anulación y los estados. | Fase 6 | Contador de la clínica / Apiworking |
| 4 | **Tamaño estimado** de usuarios, pacientes, adjuntos y sedes. | Dimensiona VPS, disco, índices, ancho de banda de respaldos y límites de subida. | Fase 0 (infraestructura) | Clínica Demo |
| 5 | **Política de acceso del Administrador de clínica a historias clínicas** (ninguno, lectura con motivo auditado, lectura libre auditada). | Define permisos y auditoría; hoy la matriz lo deja abierto. | Fase 1 | Clínica Demo / asesor normativo |
| 6 | **Confirmar que el cierre con contraseña es reautenticación, no firma clínica ni legal.** Si la clínica espera valor legal, se necesita firma manuscrita/digital (P1) y validación normativa. | Evita expectativas falsas sobre el valor del cierre de evoluciones. | Fase 2 | Clínica Demo / asesor normativo |
| 7 | **Estrategia de backup externo y prueba de restauración:** destino, proveedor, costo, cifrado, retención, frecuencia de pruebas, responsable. Confirmar respaldo diario externo antes de producción. | Riesgo principal de pérdida de datos clínicos. | Antes del piloto (fase 8) | Equipo técnico / Clínica Demo |
| 8 | **Conservación indefinida** de la historia clínica frente a la normativa sanitaria y de datos personales. | Decisión comercial no validada. | Antes del piloto | Asesor normativo |
| 9 | **Protección de datos personales:** consentimientos, bases de legitimación, registro de bancos de datos y transferencia a un proveedor externo (VPS, respaldos). | Obligaciones legales aún no evaluadas. | Antes del piloto | Asesor normativo |
| 10 | **Mapeo de estados de comprobante** entre Apiworking/SUNAT y los estados locales propuestos. | Los estados de la sección 4 son propuestos, no confirmados. | Fase 6 | Apiworking |
| 11 | **Acceso de soporte de plataforma** a datos clínicos (ninguno / temporal con justificación). | Define el rol Administrador de plataforma. | Fase 1 | Equipo de producto |
| 12 | **Migración de pacientes existentes** de Clínica Demo (formato, volumen, calidad). | Puede requerir importador en P0. | Fase 8 | Clínica Demo |
| 13 | **Cifrado en reposo** de adjuntos y respaldos, y antivirus de adjuntos. | Depende de recursos del VPS. | Fase 8 | Equipo técnico |
| 14 | **Cookie de refresh entre `dental...` y `api.dental...`** con `SameSite=Lax`. | Debe comprobarse en navegadores reales. | Fase 1 | Equipo técnico |

---

## Siguiente paso previsto
Una vez validado este documento, inspeccionar el repositorio y proponer el primer incremento implementable: autenticación, tenancy, usuarios/roles y estructura base de NestJS + Prisma. No se inicia ningún cambio de código hasta entonces.
