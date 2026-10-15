# Sub-incremento 3.0: acceso seguro (invitaciones, sesiones, reautenticación, recuperación y mantenimiento)

Cierra las condiciones mínimas para dar acceso **real** a usuarios antes de manejar información clínica. Complementa a [`incremento-1-fundacion.md`](incremento-1-fundacion.md), [`incremento-2-pacientes.md`](incremento-2-pacientes.md), [`politica-acceso-clinico.md`](politica-acceso-clinico.md) y [`incremento-3-historia-clinica.md`](incremento-3-historia-clinica.md).

**No** incluye entidades ni endpoints de historia clínica, relación asistencial ni `clinical:read_all`. Convención: **[por validar]** = decisión provisional.

---

## 1. Qué cambia respecto de los incrementos 1 y 2

| Antes | Ahora |
|---|---|
| Solo access token de 15 min; sin refresh ni logout real | Sesiones con **refresh token rotativo**, logout de la sesión actual y global, detección de reutilización |
| `POST /v1/users`: el administrador creaba usuarios **fijando su contraseña** | **Eliminado.** Los usuarios nuevos solo entran por **invitación** y eligen su propia contraseña |
| Excepción: la plataforma otorgaba roles de clínica directamente | **Retirada.** La plataforma solo invita al **primer** administrador de una clínica sin administrador |
| Sin reautenticación | `POST /v1/auth/reauthenticate`: prueba corta, de un solo uso, por propósito y objeto |
| Sin rol de autoridad clínica | Rol **Director Clínico** (sin permisos clínicos todavía) designable solo por invitación formal |
| Una clínica podía quedar sin administrador | **Regla de último administrador/Director** con bloqueo transaccional |

---

## 2. Confirmado, supuestos, riesgos

**Confirmado (instrucción del producto):** access token corto; refresh rotativo con solo su hash; cookie HttpOnly/Secure/host-only para `dental.apiworking.com.pe` y `api.dental.apiworking.com.pe`; CORS estricto con credenciales solo para el origen permitido; reautenticación que **no** es firma; invitaciones de un solo uso con hash del token y sin proveedor de correo asumido; `clinical:read_all` **no** se crea todavía.

**Supuestos tomados (reversibles):**

| # | Supuesto |
|---|---|
| S1 | Access token 15 min; sesión inactiva 8 h; tope absoluto 7 días (configurables). |
| S2 | Modo estricto ante reutilización de refresh (gracia = 0): cualquier reutilización revoca la sesión. El panel debe **serializar** las renovaciones (un solo refresh a la vez, p. ej. con un bloqueo entre pestañas). |
| S3 | La invitación vence a las 72 h; el registro de aprovisionamiento a los 30 días. |
| S4 | La reautenticación vale 2 min y un solo uso. |
| S5 | Un docente en varias clínicas usa **una cuenta**; para aceptar una segunda invitación demuestra su contraseña actual. |
| S6 | El canal de entrega se conecta mediante un **webhook firmado**; el operador lo enlaza con su sistema de envío. |
| S7 | Solo cuentan como "autoridad" el administrador **de toda la clínica** (no de una sede) y el Director, siempre con usuario y clínica activos. |

**Riesgos y limitaciones:** ver sección 10.

---

## 3. Sesiones, refresh token y logout

### 3.1 Modelo

- **Access token** (JWT HS256, 15 min): lleva `sub`, `sid` (id de sesión) y, si se eligió, el contexto. **El guard consulta la sesión en cada solicitud**, así que el logout invalida el access token **al instante** (no hay que esperar su vencimiento), igual que deshabilitar al usuario o revocar una asignación. Se guarda **solo en memoria** del panel.
- **Refresh token** (opaco, 256 bits, prefijo `rt_`): va **solo** en una cookie HttpOnly; nunca en un cuerpo, un log ni la auditoría. En la base solo existe su **SHA-256**.
- **Sesión** = "familia" de refresh tokens (`auth_sessions` + `refresh_tokens`): IP y user agent de origen, último contexto activo (se restaura al renovar), tope absoluto, motivo de revocación (`LOGOUT`, `LOGOUT_ALL`, `REUSE_DETECTED`, `EXPIRED`, `USER_DISABLED`).

### 3.2 Rotación y detección de reutilización

```
login ──► sesión S + token T0 (ACTIVE)
refresh(T0) ──► T0 pasa a ROTATED (atómico) + nuevo T1 ACTIVE
refresh(T0) otra vez ──► REUTILIZACIÓN ──► se revoca TODA la sesión S
                                           (T1, access tokens de S, contexto) + auditoría REFRESH_REUSE_DETECTED
```

- La transición `ACTIVE → ROTATED` es atómica (`UPDATE … WHERE status='ACTIVE'`): de dos renovaciones simultáneas con el mismo token **solo una gana**; la otra se trata como reutilización.
- Los tokens rotados **se conservan** precisamente para poder reconocer su reutilización. Un token de una sesión ya revocada responde un 401 simple (no se confunde con reutilización).
- El refresh token vence por **inactividad** (`REFRESH_TTL_SECONDS`) y nunca más allá del **tope absoluto** de la sesión (`SESSION_MAX_SECONDS`).
- Si el usuario fue deshabilitado, no se puede renovar y la sesión se cierra.
- `REFRESH_REUSE_GRACE_SECONDS` (por defecto 0) permite relajar la regla para dos pestañas simultáneas; con un valor > 0 una reutilización dentro de la ventana, cuyo sucesor sigue sin usarse, devuelve solo un access token. Relaja la detección: no recomendado.

### 3.3 Logout

| Endpoint | Efecto |
|---|---|
| `POST /v1/auth/logout` | Cierra la sesión actual, identificada por el access token **y/o** la cookie (funciona con el access token ya vencido). Idempotente, siempre `204` y borra la cookie. Mezclar la cookie de otro usuario no cierra su sesión. |
| `POST /v1/auth/logout-all` | Cierra **todas** las sesiones del usuario e invalida sus refresh tokens. Requiere autenticación. |

### 3.4 Cookie (diseño para los dos hosts)

El panel está en `dental.apiworking.com.pe` y la API en `api.dental.apiworking.com.pe`: **mismo sitio registrable** (`apiworking.com.pe`), distinto origen.

| Atributo | Valor | Razón |
|---|---|---|
| Nombre | `__Host-apidental_rt` (producción) / `apidental_rt` (desarrollo) | El prefijo `__Host-` obliga a `Secure`, `Path=/` y **ausencia de `Domain`**, e impide que un subdominio hermano la sobrescriba (*cookie tossing*). |
| `HttpOnly` | sí | El JavaScript del panel nunca ve el token (un XSS no puede robarlo). |
| `Secure` | sí en producción | Solo HTTPS. |
| `Domain` | **no se envía (host-only)** | Solo la recibe el host que la emitió (la API); no se comparte con el panel ni con otros subdominios. |
| `SameSite` | `Strict` | Ambos hosts son *same-site*, así que el panel puede llamar a la API con credenciales, pero ningún otro sitio logra que el navegador la adjunte. |
| `Path` | `/` | Requisito del prefijo `__Host-`. |
| `Max-Age` | `REFRESH_TTL_SECONDS` | Ventana deslizante; el tope real lo impone el servidor. |

En desarrollo (`http://localhost`) la cookie no es `Secure` ni usa el prefijo (la configuración impide combinar prefijo con `Secure=false`); el resto de atributos se mantiene.

### 3.5 Protección CSRF elegida (refresh y logout)

El resto de la API se autentica con `Authorization: Bearer`, que un navegador **no** envía por sí solo: no es vulnerable a CSRF. Solo `refresh`, `logout` y `logout-all` aceptan la cookie, y se protegen con **cuatro barreras independientes**:

1. **`SameSite=Strict`** en la cookie.
2. **`Origin` obligatorio y dentro de `CORS_ORIGINS`** (comparación exacta: `null`, otro esquema, subdominios o sufijos maliciosos se rechazan). Los navegadores siempre envían `Origin` en un `POST` y un atacante no puede falsearlo.
3. **Cabecera personalizada `X-Requested-With: ApiDental`**: convierte la solicitud en "no simple", que entre orígenes solo prospera si CORS lo autoriza.
4. **`Content-Type: application/json`** y `Sec-Fetch-Site` distinto de `cross-site`.

Cualquier fallo responde `403` **antes** de tocar el token (no lo consume). Es una defensa en profundidad: si una barrera cediera, las otras siguen.

### 3.6 CORS

Política **por solicitud**: `Access-Control-Allow-Origin` y `Access-Control-Allow-Credentials: true` se anuncian **únicamente** al origen autorizado; un origen ajeno no recibe ninguno (nunca `*`). Cabeceras permitidas: `Authorization`, `Content-Type`, `X-Request-Id`, `X-Requested-With`.

### 3.7 Lo que el panel debe hacer (contrato para el frontend)

- Guardar el access token **solo en memoria**; llamar a `refresh` con `credentials: 'include'` y las cabeceras CSRF.
- **Serializar** las renovaciones y reintentar la solicitud original tras renovar; ante `401` del refresh, volver al login.
- Mostrar el aviso de sesión por vencer cuando falte la renovación silenciosa (ver `sistema-de-diseno.md`).
- No poner tokens ni datos personales en URLs; el enlace de invitación usa el **fragmento** (`#token=…`), que no llega a servidores ni a registros de acceso.

---

## 4. Reautenticación

`POST /v1/auth/reauthenticate` `{ password, purpose, targetId? }` → `{ reauthToken, purpose, targetId, expiresAt, expiresIn: 120, singleUse: true, isSignature: false, notice }`.

- Verifica la contraseña **ahora**. Los fallos cuentan para el bloqueo progresivo (una sesión robada no puede adivinar la clave por aquí) y se auditan.
- La prueba (`rp_…`, solo su hash en BD) vale **2 minutos**, **una vez**, y únicamente para el **usuario, la sesión, el propósito y el objeto** para los que se pidió. Un propósito distinto, un objeto distinto o una sesión distinta la rechazan.
- Propósitos: `CLOSE_CLINICAL_NOTE`, `CORRECT_CLINICAL_NOTE`, `MARK_CLINICAL_NOTE_ERROR`, `CLINICAL_READ_ALL` (reservados para 3.1-3.4) y `AUTHORIZE_DIRECTOR_PROVISIONING` (ya usado por el aprovisionamiento).
- Se **consume dentro de la transacción** de la operación protegida (`ReauthService.consume`): si la operación falla, la prueba no se gasta; dos consumos simultáneos solo permiten uno.
- **Aclaración obligatoria:** una reautenticación **no equivale** a firma digital, firma legal ni firma clínica. La respuesta lo declara (`isSignature: false` y un aviso) y la interfaz debe mostrarlo: *"Confirma que usted realiza esta acción. No es una firma digital, legal ni clínica."* Si se requiere firma con valor legal, es una decisión normativa posterior **[por validar]**.

---

## 5. Invitaciones

### 5.1 Garantías

| Requisito | Cómo se cumple |
|---|---|
| Un solo uso, con expiración y revocación | Estados `PENDING → ACCEPTED / REVOKED / EXPIRED`, transiciones atómicas y bloqueo de la fila al aceptar; un trigger impide reabrir una invitación cerrada. |
| Token nunca en claro | 256 bits (`inv_…`), solo su SHA-256 en la BD; el valor viaja únicamente por el canal de entrega. **Reenviar genera un token nuevo** (el anterior deja de valer). |
| La persona crea su propia contraseña | Cuenta nueva: la elige al aceptar (≥ 12 caracteres, Argon2id). Quien invita nunca la conoce. |
| Una invitación **nunca** cambia la clave de una cuenta existente | Cuenta existente: debe demostrar **su** contraseña actual; esta no se modifica (ni los datos del perfil). Los fallos cuentan para el bloqueo. |
| No revelar si un correo ya existe | La **creación** responde idéntico exista o no la cuenta; todo fallo de **token** (inexistente, manipulado, vencido, revocado, usado) responde exactamente lo mismo; los mensajes de validación no repiten el valor enviado. El indicador `requiresExistingPassword` solo lo ve quien posee el token (el destinatario). |
| Enlace/token solo en desarrollo o pruebas | `INVITATION_DELIVERY_MODE=dev` devuelve `devAcceptUrl`; **la API se niega a iniciar así en producción**. |
| Producción: canal configurable, sin asumir proveedor | `webhook` (POST firmado) o `disabled` (por defecto: la creación **falla cerrada** con `503`, sin dejar invitación). |
| Auditoría | `INVITATION_CREATED`, `…_SENT`, `…_DELIVERY_FAILED`, `…_RESENT`, `…_ACCEPTED`, `…_REJECTED`, `…_REVOKED`, `…_EXPIRED` (con destinatario enmascarado y sin token). |

### 5.2 Canal webhook

`POST` a `INVITATION_WEBHOOK_URL` con `{ event, invitationId, to, acceptUrl, clinicName, roleName, expiresAt }`, firmado: `X-ApiDental-Signature: sha256=HMAC(secret, "<timestamp>.<cuerpo>")` y `X-ApiDental-Timestamp` (segundos; el receptor debe rechazar repeticiones). Tiempo límite de 5 s, **sin seguir redirecciones**, y nunca se registran la URL, el cuerpo ni la respuesta. Un fallo deja la invitación en `delivery.status = FAILED` con un motivo genérico (`http_500`, `timeout`, `network`) y se puede **reenviar**. El enlace tiene la forma `INVITATION_ACCEPT_BASE_URL#token=…`.

### 5.3 Quién puede invitar

| Quién | A quién | Condiciones |
|---|---|---|
| **Plataforma** | **Primer `CLINIC_ADMIN`** de una clínica | Solo si la clínica **no tiene administrador de toda la clínica activo** (ventana de aprovisionamiento). Se vuelve a comprobar al aceptar. |
| Plataforma | Otro `PLATFORM_ADMIN` | Sin clínica. |
| **Administrador de clínica** | Personal de **su** clínica (y sede) | Anti-escalada (no más permisos que los suyos); no puede invitar al Director. |
| **Director Clínico** | Otro Director | Con reautenticación; sin registro de aprovisionamiento. |
| Nadie más | — | Recepción, odontólogo, asistente, caja y la propia plataforma (para roles distintos de los anteriores) reciben 403. |

Al **aceptar** se revalida todo: clínica y sede activas, quien invitó sigue activo y con autoridad, la clínica sigue sin administrador (si la emitió la plataforma), el registro de aprovisionamiento sigue vigente, etc. La aceptación corre en `READ COMMITTED` con bloqueo de la clínica; sin eso, dos aceptaciones simultáneas podían superar la regla (defecto encontrado y corregido durante las pruebas).

---

## 6. Aprovisionamiento formal y Director Clínico

### 6.1 Flujo del primer Director

```
Administrador de la clínica ──(reautenticación)──► registra el aprovisionamiento formal
        │   { designado, autorizante + cargo + documento (enmascarado), referencia del documento, fecha }
        ▼
Administrador ──(reautenticación)──► invita al Director  (solo al correo designado en el registro)
        ▼
Designado acepta ──► obtiene CLINICAL_DIRECTOR · el registro pasa a CONSUMED · todo auditado
```

Después, **solo un Director vigente** designa a otro (con reautenticación, sin registro). El administrador ya no puede, y la plataforma **nunca**.

### 6.2 El registro de aprovisionamiento

- Campos: `designeeName/Email`, `authorizedByName/Position/DocumentType/DocumentNumber` (DNI, CE, pasaporte o RUC), `authorizationReference`, `authorizationDate` (no futura, ≤ 1 año), notas. El documento se **muestra enmascarado**; la auditoría **no** copia nombres ni documento.
- Lo **registra el administrador de la clínica** (permiso `provisioning:record`, que la plataforma no tiene) con reautenticación. Vence a los 30 días, es **inmutable** (trigger) y no se elimina; solo avanza a `CONSUMED`, `REVOKED` o `EXPIRED`. Un solo registro vigente por clínica.
- La invitación del Director debe dirigirse **exactamente** al correo designado en el registro.

### 6.3 Limitación documentada (importante)

> **Mientras no exista firma electrónica ni un flujo contractual integrado, el registro es una *declaración asentada* por el administrador de la clínica.** El sistema **no verifica** que el documento citado exista ni que lo haya firmado quien se dice. Lo que sí garantiza: lo registra una persona **autenticada y reautenticada** de la clínica (no la plataforma), queda **inmutable y auditado**, se vincula a **un único destinatario**, **vence** y se **consume** al usarse. La verificación real de la autorización (p. ej., contrato firmado con Apiworking, firma digital del representante) es una decisión posterior **[por validar]**. Hasta entonces, se recomienda un **control operativo fuera del sistema**: contrastar el documento con la clínica antes de dar acceso real.

### 6.4 Roles y permisos creados (solo los necesarios)

| Elemento | Detalle |
|---|---|
| Rol **`CLINICAL_DIRECTOR`** | Ámbito clínica. Permisos: lectura básica de clínica/sede/roles, `invitation:read`, `provisioning:read`, `director:manage` y la lectura demográfica de pacientes/consentimientos/adjuntos. **Sin ningún permiso `clinical:*`.** |
| `invitation:read` / `invitation:manage` | Plataforma y administrador de clínica. |
| `provisioning:record` / `provisioning:read` | **Solo** el administrador de clínica (y `read`, también el Director). La plataforma **no** los tiene. |
| `director:manage` | **Solo** el Director Clínico. |
| `clinical:read_all` | **No existe todavía.** Se creará en 3.1 junto con su justificación obligatoria, su auditoría de acceso y el control de relación asistencial. |

`CLINICAL_DIRECTOR` no puede otorgarse por `POST /v1/assignments` (ni siquiera el administrador de clínica): solo por invitación formal.

---

## 7. Regla de último administrador (y de su equivalente para el Director)

Una clínica **nunca** queda sin autoridad administrativa ni, una vez designado, sin autoridad clínica; la plataforma tampoco queda sin `PLATFORM_ADMIN`.

- Protegidos: `CLINIC_ADMIN` **de toda la clínica**, `CLINICAL_DIRECTOR` y `PLATFORM_ADMIN`. El administrador de una sola sede **no** cuenta como autoridad.
- Cuentan solo autoridades operativas: asignación activa, **usuario activo** y clínica activa.
- Al revocar una asignación se lee con **bloqueo (`SELECT … FOR UPDATE`)** el resto de autoridades; dos revocaciones simultáneas se serializan y la segunda ve el resultado de la primera (probado: de dos revocaciones concurrentes, solo una prospera).
- Respuesta `409 { code: 'LAST_AUTHORITY' }` y auditoría `LAST_AUTHORITY_BLOCKED` (persistente aunque la transacción se revierta).
- El mismo servicio (`LastAuthorityService`) **debe invocarse también cuando exista la deshabilitación de usuarios**; hoy ese endpoint no existe.

---

## 8. Endpoints nuevos o cambiados

| Ruta | Permiso | Nota |
|---|---|---|
| `POST /v1/auth/login` | público | Además fija la cookie del refresh token. |
| `POST /v1/auth/refresh` | cookie + CSRF | Rota el refresh token; restaura el contexto. |
| `POST /v1/auth/logout` · `POST /v1/auth/logout-all` | cookie/Bearer + CSRF | Sesión actual / todas. |
| `POST /v1/auth/reauthenticate` | autenticado | Prueba de 2 min, un solo uso. |
| `POST /v1/invitations` | `invitation:manage` o `director:manage` | Según el rol invitado. 503 sin canal. |
| `GET /v1/invitations` | `invitation:read` | Sin token ni hash. |
| `POST /v1/invitations/:id/revoke` · `/resend` | manage | Revocar exige motivo; reenviar rota el token. |
| `POST /v1/invitations/preview` · `/accept` | **público** (límite estricto por IP) | Cuenta nueva o existente. |
| `POST /v1/provisioning-records` · `GET` · `POST /:id/revoke` | `provisioning:record` / `provisioning:read` | Solo la clínica; reautenticación. |
| `POST /v1/auth/password-recovery` · `/validate` · `/confirm` | **público** (límite estricto por IP) | Solicitud con `202` neutral; `confirm` revoca todas las sesiones y no inicia sesión. |
| `POST /v1/users/:id/disable` · `/reactivate` | `user:manage` | Motivo obligatorio; nunca elimina; regla de última autoridad. |
| ~~`POST /v1/users`~~ | — | **Eliminado.** |
| `POST /v1/assignments` | `assignment:manage` | La plataforma ya no otorga roles de clínica; el Director no se otorga por aquí. |
| `PATCH /v1/assignments/:id/revoke` | `assignment:manage` | Aplica la regla de último administrador. |

---

## 8 bis. Recuperación, deshabilitación, mantenimiento y accesos denegados

### Recuperación de contraseña
- **Solicitud neutral:** `POST /v1/auth/password-recovery` responde siempre `202` con el mismo cuerpo, exista o no la cuenta, esté o no deshabilitada; el trabajo real ocurre **en segundo plano**, así que el tiempo de respuesta no distingue los casos (probado). Cuentas inexistentes o deshabilitadas no generan token ni auditoría.
- **Token:** 256 bits (`pr_…`), solo se guarda su SHA-256, un solo uso, vigencia `PASSWORD_RECOVERY_TTL_MINUTES` (30). Una sola recuperación pendiente por cuenta: una solicitud nueva reemplaza a la anterior. Espera mínima (`…_COOLDOWN_SECONDS`) y tope diario (`…_MAX_PER_DAY`) **silenciosos** (no revelan nada).
- **Confirmación** (`READ COMMITTED` + `FOR UPDATE`): aplica la política de contraseña (12–128, variedad mínima, ≠ correo; la misma que al aceptar invitaciones), exige que sea **distinta de la actual**, revoca **todas** las sesiones (`PASSWORD_RECOVERY`→ razón `PASSWORD_RESET`), marca como usadas las pruebas de reautenticación, revoca invitaciones pendientes al correo y otras recuperaciones, limpia el bloqueo por intentos y **no inicia sesión**.
- **Canal:** comparte el de las invitaciones (`dev`/`webhook`/`disabled`); evento `password_recovery.deliver`. Un fallo del canal se audita (`PASSWORD_RECOVERY_DELIVERY_FAILED`) pero la respuesta sigue siendo neutral.
- **Auditoría:** `PASSWORD_RECOVERY_REQUESTED/SENT/DELIVERY_FAILED/COMPLETED/REJECTED/EXPIRED`, sin token, sin contraseña y sin el correo ajeno.

### Deshabilitar y reactivar
- Nunca se elimina al usuario ni se tocan sus asignaciones ni su auditoría. Deshabilitar revoca sesiones y refresh tokens, invalida pruebas de reautenticación y recuperaciones; el guard y el login ya rechazan a la cuenta en la solicitud siguiente.
- **Alcance:** la clínica solo gestiona usuarios con asignación activa en ella (404 uniforme en caso contrario). Como deshabilitar es **global**, una cuenta con accesos fuera de esa clínica responde `409 ACCOUNT_SHARED` (se revoca su asignación en su lugar). El administrador limitado a una sede solo gestiona a quienes trabajan solo allí. Nadie se deshabilita a sí mismo. La plataforma puede con cualquiera y **solo ella reactiva lo que ella deshabilitó** (`disabledByPlatform`).
- **Regla de última autoridad:** no se puede deshabilitar al último administrador de una clínica ni al último Director (una vez designado). `LastAuthorityService` bloquea primero la fila de la clínica (`FOR UPDATE`) en orden estable, así que dos deshabilitaciones concurrentes se serializan; los deadlocks residuales (también los que MySQL reporta como `P2010`/1213 desde consultas crudas) se **reintentan** (`withTxRetry`).
- Reactivar **no restaura sesiones**: la persona debe iniciar sesión de nuevo.

### Mantenimiento de seguridad
`npm run maintenance[:dry-run]` (`dist/maintenance/cli.js`). Pasa a vencidas las invitaciones, recuperaciones, registros de aprovisionamiento y sesiones caducadas, y **depura por lotes** (`MAINTENANCE_BATCH_SIZE` × `MAINTENANCE_MAX_BATCHES`; si queda trabajo, `truncated: true` y continúa la siguiente ejecución): sesiones revocadas (con sus refresh tokens y pruebas) tras `RETENTION_SESSIONS_DAYS`, pruebas de reautenticación tras `RETENTION_REAUTH_DAYS`, e invitaciones/recuperaciones **cerradas** tras `RETENTION_INVITATIONS_DAYS`/`RETENTION_RECOVERIES_DAYS` (mínimo 30; lo imponen también los triggers: una invitación pendiente o con menos de 30 días no se puede borrar ni por SQL). **Nunca** depura auditoría, usuarios, asignaciones ni el registro de aprovisionamiento. Audita `MAINTENANCE_PURGE` solo con contadores. Es idempotente y no tiene bloqueo de ejecución propio: use el timer `oneshot` (`deploy/systemd/apidental-maintenance.*.example`). Los plazos de retención son **[por validar]** con asesoría legal.

### Auditoría de accesos denegados
- `ACCESS_DENIED` por cada `403` de un usuario **autenticado** con contexto de petición: método, **patrón de ruta** (`/v1/patients/:id/consents`, nunca el id ni la consulta), motivo (`no_context`, `missing_permission`, `forbidden`) y permisos exigidos. Sin cuerpo, cabeceras ni datos personales. Deduplicado 60 s por usuario+ruta+motivo para que un abuso no inunde la auditoría. No se audita el `403` de CSRF (no hay identidad) ni los `401/400/404`.
- `REAUTH_REJECTED` cuando una prueba de reautenticación se rechaza al consumirla, con la razón (`malformed`, `unknown`, `other_user`, `other_session`, `other_purpose`, `other_target`, `already_used`, `expired`) y sin el token. `REAUTH_FAILED` (contraseña incorrecta) y `REFRESH_REUSE_DETECTED` ya existían.
- Visibles para cada clínica en `GET /v1/audit-logs?action=ACCESS_DENIED`.

---

## 9. Modelo de datos nuevo

`auth_sessions`, `refresh_tokens` (solo hash; el hash y la sesión son inmutables), `reauth_proofs` (solo se puede marcar como usada, una vez), `invitations` (destinatario, rol, alcance y emisor inmutables; sin `DELETE`; estados cerrados no se reabren; CHECK de sede con clínica) y `provisioning_records` (contenido inmutable; sin `DELETE`). `password_recoveries` (solo hash; núcleo inmutable; solo se purgan cerradas con más de 30 días) y, en `users`, `disabled_at/by/reason` y `disabled_by_platform`. Las invitaciones cerradas con más de 30 días pueden depurarse. Migraciones `20261014020000_sessions_invitations_provisioning`, `20261014030000_invitation_issuer` y `20261014040000_recovery_disable_maintenance`.

---

## 10. Riesgos residuales y limitaciones

1. **Un operador de plataforma que controle un correo puede invitarlo como primer administrador de una clínica sin administrador.** El sistema no puede saber que ese correo es del propio operador. Controles: solo existe esa ventana (sin administrador), la persona define su clave, **no obtiene acceso clínico** ni puede designar al Director por sí sola (exige registro formal + reautenticación + ser el administrador), y queda todo **trazado** (`issuedByPlatform`). Mitigación operativa recomendada: verificar con la clínica, por un canal independiente, quién es su administrador antes de invitarlo **[por validar]**.
2. **El registro de aprovisionamiento es declarativo** (sección 6.3).
3. **Un administrador de clínica puede invitar una segunda identidad propia** a un rol asistencial (p. ej. odontólogo). Eso contradice la separación de funciones; en 3.1 la relación asistencial la asignan terceros y quedan informes de autoasignación; hasta entonces es un riesgo conocido.
4. **El token viaja por el canal de entrega**: la confidencialidad del enlace depende de ese canal (correo, SMS, etc.). Por eso el enlace usa fragmento, vence a las 72 h y es de un solo uso.
5. **La recuperación depende del canal de entrega**: quien controle el correo (o el receptor del webhook) controla la cuenta. No hay segundo factor. **Falta la notificación de “contraseña cambiada”** a la persona (pendiente, requiere canal).
6. **Política de contraseña mínima**: longitud, variedad y no igual al correo; sin lista de contraseñas filtradas **[por validar]**.
7. **El modo estricto ante reutilización** exige que el panel serialice las renovaciones; si no, un usuario con varias pestañas verá cierres de sesión.
8. **El access token no tiene `jti`**: dos emisiones en el mismo segundo para la misma sesión y contexto producen el mismo JWT (no es una vulnerabilidad: la revocación va por la sesión).
9. **El mantenimiento no tiene bloqueo de ejecución**: es idempotente, pero dos instancias simultáneas solo competirían por las mismas filas; use el timer `oneshot`. Retenciones **[por validar]**.
10. **Un administrador de clínica puede deshabilitar al Director** (queda protegido solo por la regla de último Director). En 3.1 conviene exigir reautenticación y/o que lo decida un Director.
11. **Alertas**: los eventos (`ACCESS_DENIED`, `REAUTH_REJECTED`, `REFRESH_REUSE_DETECTED`) quedan auditados, pero **no hay alertas automáticas** ni panel; debe revisarlos una persona.
12. **Aceptación y confirmación en `READ COMMITTED`**: se eligió para evitar la instantánea de `REPEATABLE READ` bajo concurrencia; los deadlocks se reintentan.

---

## 11. Verificación (2026-10-14, MySQL Community 8.4.6, base creada desde cero)

| Comprobación | Resultado |
|---|---|
| 5 migraciones desde cero y sin desvío con el schema; seed dos veces | Correcto |
| Pruebas unitarias | 96 de 96 |
| Pruebas e2e (25 archivos), dos corridas completas | **368 de 368** |
| Concurrencia de deshabilitación/última autoridad/aprovisionamiento, 12 repeticiones | 45 de 45 cada vez |
| `tsc --noEmit`, `oxlint --type-aware`, `nest build` | Sin errores ni avisos |
| `npm audit` | 0 vulnerabilidades |
| `npm run maintenance:dry-run` sobre la base nueva | Resumen JSON correcto |

Cobertura pedida: invitación válida, expirada, revocada, reutilizada y manipulada; aceptación sin filtración de correo; rotación y **reutilización** de refresh token; logout de una sesión y global; reautenticación correcta, incorrecta, expirada y usada para otro propósito/objeto/sesión; aislamiento entre clínicas; auditoría de todas las acciones sensibles; y que **ningún token, hash ni contraseña aparezca** en respuestas no autorizadas, logs ni auditoría (prueba transversal con un logger que captura todo; comprobada con mutaciones que inyectan una fuga).

Defectos reales hallados por las pruebas y corregidos: (1) CORS anunciaba `Allow-Credentials` a orígenes no permitidos; (2) la aceptación concurrente podía superar la regla "clínica sin administrador" por la instantánea de `REPEATABLE READ` (ahora `READ COMMITTED` + bloqueo); (3) la prueba de fugas no detectaba hashes expuestos (ahora sí); (4) **un deadlock entre dos deshabilitaciones cruzadas devolvía `500`**: MySQL lo reporta desde `SELECT … FOR UPDATE` como `P2010`/1213 y no como `P2034`, así que no se reintentaba (ahora `withTxRetry` lo reconoce; 12 repeticiones sin fallo).

---

## 12. Para iniciar el sub-incremento 3.1

**Prerrequisitos ya cubiertos:** sesiones y logout, reautenticación con propósitos reservados, invitación y aprovisionamiento, rol Director, regla de último administrador, plataforma sin vía de designación clínica.

**Pasos de 3.1** (modelo base, relación asistencial, permisos clínicos, `clinical:read_all`, auditoría clínica):

1. Decidir las preguntas abiertas de producto (vista de apoyo del asistente, vigencia de la relación asistencial, si el odontólogo ve entradas de otras sedes, consentimiento clínico obligatorio u opcional) y las normativas críticas.
2. Crear `clinical:read_all` **junto con** su justificación obligatoria (categoría + motivo), autorización de lectura de 30 min por paciente, auditoría previa a la entrega (falla cerrada) y consumo de la prueba `CLINICAL_READ_ALL`; asignarlo **solo** al rol Director Clínico.
3. Crear `clinical:read`, `clinical:write`, `clinical:read_limited` y `care:assign`, y la relación asistencial con sus orígenes.
4. Auditar también los **accesos clínicos denegados**.
5. Mitigar que un administrador invite una segunda identidad propia y que deshabilite al Director sin intervención de un Director.
6. Antes de cargar **datos reales**: canal de entrega probado, mantenimiento programado, notificación de contraseña cambiada, respaldo diario externo con restauración probada y revisión legal de los puntos del documento del incremento 3.

**Cerrado en 3.0:** recuperación de contraseña, deshabilitación/reactivación con la regla de última autoridad, política de depuración y auditoría de accesos denegados.
