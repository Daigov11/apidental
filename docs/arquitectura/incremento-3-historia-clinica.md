# Incremento 3 (propuesta): historia clínica

**Estado:** propuesta para revisión. **No se escribe código hasta recibir aprobación.** Se apoya en:

- [`politica-acceso-clinico.md`](politica-acceso-clinico.md) (política de acceso clínico P0, adoptada),
- [`incremento-2-pacientes.md`](incremento-2-pacientes.md) y [`incremento-1-fundacion.md`](incremento-1-fundacion.md),
- [`mvp-p0-apidental.md`](mvp-p0-apidental.md).

Convención: **[por validar]** = no es un hecho normativo ni confirmado.

---

## 1. Confirmaciones, supuestos, riesgos y preguntas

### 1.1 Confirmado (decisiones ya tomadas)

- La historia clínica pertenece al paciente y a la **clínica**, y se comparte entre sedes.
- **Las evoluciones clínicas no se eliminan físicamente**; las correcciones conservan trazabilidad (versiones).
- Política de acceso clínico: plataforma y administrador de clínica **sin** acceso; odontólogo lee/escribe **solo con relación asistencial y en sus sedes**; asistente lectura **limitada**, sin escribir; recepción y caja **sin** permisos clínicos; `clinical:read_all` **excepcional**, solo Director Clínico (o administrador expresamente autorizado), con usuario, paciente, fecha, IP y motivo **auditados**; **sin acceso de soporte** de plataforma.
- Cierre de una evolución = **reautenticación con contraseña**, **no** firma legal ni digital.
- **No** se envía información clínica a Apiworking. **Sin** IA clínica.
- Auditoría de **lectura y modificación** de datos clínicos.
- Fuera de este incremento: odontograma, agenda/citas, presupuestos y planes de tratamiento, pagos, firma digital, adjuntos clínicos (radiografías/fotos).

### 1.2 Supuestos (reversibles)

| # | Supuesto |
|---|---|
| A1 | Una **historia clínica** por paciente y clínica (`clinical_record`), con un **número de historia** correlativo por clínica; el formato oficial es **[por validar]**. |
| A2 | El contenido clínico se modela como **elementos versionados** con un patrón común (identificador estable + versiones + una vigente), nunca editados en sitio. |
| A3 | Las evoluciones tienen **borrador** (editable solo por su autor) y, al **cerrarse**, quedan inmutables. Las correcciones crean una **versión nueva** con motivo. |
| A4 | Diagnósticos y procedimientos aceptan **texto libre** con código **opcional**; la codificación oficial (CIE-10, nomenclaturas de procedimientos) es **[por validar]**. |
| A5 | La relación asistencial se establece en P0 por **asignación** (recepción/administración/Director), **derivación** o **autoasignación con motivo y revisión**; la vía por citas llega con la agenda. |
| A6 | Las **correcciones** de una evolución las hace **su autor**; otro odontólogo agrega un **adendo** vinculado (no edita lo ajeno). **[por validar]** |
| A7 | El acceso `clinical:read_all` usa una **autorización de lectura de 30 minutos por paciente**, con categoría y motivo. |
| A8 | El texto clínico libre se protege con **cifrado de disco y respaldos cifrados** en P0; el cifrado a nivel de campo queda como decisión (ver 2.4). |
| A9 | Lo clínico es **append-only a nivel de base de datos** (triggers), como en el incremento 2. |

### 1.3 Riesgos

1. **Normativa:** el contenido mínimo, la codificación, los plazos y la forma de rectificar la historia son **[por validar]**; un modelo demasiado rígido podría rehacerse.
2. **Derechos del paciente vs. inmutabilidad:** el derecho de rectificación y la historia inmutable deben convivir (las versiones lo permiten; falta validar el criterio legal).
3. **Fricción en la atención:** si la relación asistencial exige pasos, los odontólogos pueden sentirlo como obstáculo → la autoasignación con motivo evita bloqueos pero genera revisión.
4. **Abuso de la autoasignación** (un odontólogo se asigna pacientes ajenos): mitigado con motivo, marca de revisión e informe al Director Clínico.
5. **Datos clínicos en la auditoría o en *logs*:** reglas estrictas de no copiar contenido.
6. **Vía indirecta de plataforma** (excepción de aprovisionamiento): **resuelta en 3.0** (invitación de un solo uso); persiste un riesgo residual acotado y documentado.
7. **Acceso técnico a la base de datos** por quien opere el VPS (riesgo residual; ver política).
8. **Rendimiento** de historias con muchos registros: paginación e índices por paciente.
9. **Pérdida de datos clínicos:** el respaldo diario externo con prueba de restauración deja de ser recomendable y pasa a **obligatorio**.

### 1.4 Preguntas abiertas críticas

Las normativas están en la sección 10. Las de producto que bloquean el diseño fino: contenido de la vista de apoyo del asistente, vigencia de la relación asistencial, si el odontólogo ve entradas de otras sedes, y si se exige **consentimiento clínico vigente** para registrar (propuesta: **advertir, no bloquear**).

---

## 2. Alcance y modelo de datos

### 2.1 Incluido

Historia clínica (apertura y numeración) · **antecedentes** médicos y odontológicos · **alergias** (y su evaluación) · **alertas clínicas** · **visitas/atenciones** · **diagnósticos** · **procedimientos realizados** · **evoluciones versionadas** con reautenticación al cerrar · relación asistencial y equipo tratante · acceso excepcional `clinical:read_all` con justificación · auditoría clínica · API documentada y probada. Sin interfaz.

### 2.2 Excluido

Odontograma (incremento 4, reutilizará el patrón y la relación asistencial) · agenda/citas (la visita queda con `appointment_id` nulo preparado) · adjuntos clínicos (propuesta de incremento **3b** reutilizando el almacenamiento privado, con permisos clínicos propios) · planes de tratamiento y presupuestos · recetas · firma digital/manuscrita · odontopediatría específica · integración con Apiworking · IA · importación de historias previas.

### 2.3 Entidades

Todas con `clinic_id`, FK compuesta `(patient_id, clinic_id) → patients(id, clinic_id)`, autor y marcas de tiempo (UTC). **Ninguna se elimina físicamente.**

**Patrón de "elemento versionado"** (antecedentes, alergias, alertas, diagnósticos, procedimientos y evoluciones):

| Columna | Función |
|---|---|
| `item_id` | Identificador estable del elemento a través de sus versiones |
| `version` | 1, 2, 3… (único por `item_id`) |
| `supersedes_id` | Versión anterior |
| `current_key` | `item_id` si es la versión vigente, **NULL** si fue reemplazada (índice único ⇒ una sola vigente) |
| `change_reason` | **Obligatorio** desde la versión 2 |
| `created_by_id`, `created_at` | Autor de **esa** versión |

Los *triggers* solo permiten un `UPDATE`: poner `current_key` en `NULL` al reemplazarla. Todo lo demás es inmutable.

| Entidad | Contenido principal |
|---|---|
| **`clinical_record`** | `id`, `clinic_id`, `patient_id` (**único** por clínica), `record_number` (correlativo por clínica), `opened_at`, `opened_by_id`. Se crea en el primer registro clínico o al asignar el paciente. |
| **`patient_care_relationship`** | `patient_id`, `dentist_user_id`, `source` (`ASSIGNMENT`, `REFERRAL`, `SELF_ASSIGNED`, luego `APPOINTMENT`), `status` (`ACTIVE`/`ENDED`), `started_at`, `ended_at`, `reason` (obligatorio en autoasignación y derivación), `needs_review`/`reviewed_by`/`reviewed_at`, `created_by_id`. Clave `paciente\|odontólogo` única mientras esté activa. |
| **`background_entry`** *(versionado)* | `category` (`PERSONAL_MEDICAL`, `FAMILY`, `SURGICAL`, `MEDICATIONS`, `HABITS`, `DENTAL`, `OTHER`), `description` (≤ 1000), `status` (`ACTIVE`/`RESOLVED`), `onset_note`. |
| **`allergy`** *(versionado)* | `agent` (≤ 200), `category` (`MEDICATION`, `ANESTHETIC`, `LATEX`, `MATERIAL`, `FOOD`, `OTHER`), `reaction`, `severity` (`MILD`/`MODERATE`/`SEVERE`), `status` (`ACTIVE`/`INACTIVE`/`ENTERED_IN_ERROR`), `source` (`REPORTED`/`CONFIRMED`). |
| **`allergy_assessment`** *(solo inserta)* | `status` (`NOT_ASSESSED`, `NONE_KNOWN`, `HAS_ALLERGIES`), quién y cuándo. Distingue "no preguntado" de "sin alergias conocidas". La última fila manda. |
| **`clinical_alert`** *(versionado)* | `kind` (`MEDICAL_CONDITION`, `MEDICATION_RISK`, `PREGNANCY`, `OTHER`), `severity` (`INFO`/`WARNING`/`CRITICAL`), `text` (≤ 300), `active`, `expires_at`. Las alergias **graves** generan una alerta **derivada** (no almacenada). |
| **`visit`** | `id`, `clinic_id`, `patient_id`, `branch_id` (FK compuesta con la clínica), `dentist_user_id`, `visit_number` (correlativo por historia), `status` (`OPEN`/`CLOSED`/`CANCELLED`), `started_at`, `closed_at`, `chief_complaint` (≤ 500), `appointment_id` (nulo hasta la agenda), `cancel_reason`. Una visita cerrada es inmutable; para corregirla se corrigen sus elementos. |
| **`diagnosis`** *(versionado)* | `visit_id`, `description` (≤ 500), `code` + `code_system` (opcionales, **[por validar]**), `tooth_fdi` (opcional), `type` (`PRESUMPTIVE`/`DEFINITIVE`), `status` (`ACTIVE`/`RESOLVED`/`RULED_OUT`/`ENTERED_IN_ERROR`). |
| **`procedure_performed`** *(versionado)* | `visit_id`, `description` (≤ 500), `code` opcional, `tooth_fdi`, `surfaces`, `performed_at`, `status` (`COMPLETED`/`PARTIAL`/`ENTERED_IN_ERROR`), `notes` (≤ 1000); vínculo opcional a diagnósticos (`procedure_diagnosis`). Sin precio ni cobro: no genera presupuestos ni cargos. |
| **`clinical_note`** *(versionado)* — la **evolución** | `visit_id`, `kind` (`EVOLUTION`/`ADDENDUM`), `body` (≤ 10 000), `plan` (≤ 3000), `status` (`DRAFT`/`CLOSED`/`DISCARDED`/`ENTERED_IN_ERROR`), `closed_at`, `closed_by_id`, `content_hash` (SHA-256 al cerrar, evidencia de integridad). |
| **`reauth_event`** | `user_id`, `purpose` (`CLOSE_NOTE`, `CORRECT_NOTE`, `MARK_ERROR`), `target_id`, `created_at`, `used_at`, `ip`. Un solo uso, vigencia de 2 minutos. **No es una firma.** |
| **`clinical_access_grant`** | Autorización de `clinical:read_all`: `user_id`, `patient_id`, `category`, `reason`, `granted_at`, `expires_at`, `ip`, `user_agent`. Solo inserta. |

### 2.4 Garantías en la base de datos (MySQL 8.4)

- FK compuestas `(patient_id, clinic_id)` y `(branch_id, clinic_id)`: aislamiento aun por SQL directo.
- **Sin `DELETE`** en ninguna tabla clínica (triggers).
- **Versiones inmutables**: el único `UPDATE` permitido es reemplazar `current_key` por `NULL`; `item_id`, `version` y contenido no cambian.
- **Evolución cerrada inmutable**: solo se edita mientras `status = DRAFT`; `CLOSED` exige `closed_at`, `closed_by_id` y `content_hash` (CHECK).
- `UNIQUE (item_id, version)` y `current_key` único ⇒ una sola versión vigente por elemento.
- `change_reason` obligatorio desde la versión 2 (CHECK).
- El `patient_id`/`clinic_id` de un elemento no cambian (trigger).
- **Cifrado:** en P0, cifrado de disco y respaldos cifrados. **Decisión pendiente:** cifrado a nivel de campo (AES-256-GCM con la clave fuera de la base) para `body`, `plan`, `description`; protege ante una copia de la BD pero impide buscar por contenido. Recomendación: decidirlo tras revisar el modelo de amenazas con el responsable legal.

---

## 3. Permisos

Nombres propuestos (se crean con su control y pruebas, no antes):

| Permiso | Quién |
|---|---|
| `clinical:read` | Odontólogo (con relación + sede) |
| `clinical:write` | Odontólogo (con relación + sede) |
| `clinical:read_limited` | Asistente (con relación + sede) → vista de apoyo |
| `clinical:read_all` | Director Clínico (rol nuevo) o administrador expresamente autorizado |
| `care:assign` | Recepción, administración, Director Clínico (acto administrativo) |

| Acción | Odontólogo | Asistente | Director | Admin clínica | Recepción | Caja | Plataforma |
|---|---|---|---|---|---|---|---|
| Ver historia, antecedentes, alergias, alertas | ✔* | apoyo* | ✔ (grant) | — | — | — | — |
| Ver visitas, diagnósticos, procedimientos | ✔* | apoyo* | ✔ (grant) | — | — | — | — |
| Ver texto de evoluciones | ✔* | — | ✔ (grant) | — | — | — | — |
| Registrar/revisar antecedentes, alergias, alertas | ✔* | — | — | — | — | — | — |
| Abrir/cerrar visita; diagnósticos; procedimientos | ✔* | — | — | — | — | — | — |
| Redactar, cerrar y **corregir** evoluciones | ✔* (autor) | — | — | — | — | — | — |
| Agregar adendo a evolución ajena | ✔* | — | — | — | — | — | — |
| Asignar paciente a odontólogo | — | — | ✔ | ✔ | ✔ | — | — |
| Otorgar/revocar rol Director Clínico | — | — | ✔ (otros) | — | — | — | — |

\* con relación asistencial vigente y sede asignada. "(grant)" = con autorización de lectura justificada.

**Algoritmo de autorización (falla cerrada, auditado):**

1. JWT válido + **contexto de clínica** (la plataforma queda fuera).
2. Permiso del módulo.
3. El paciente pertenece a la clínica (404 uniforme si no).
4. Odontólogo/asistente: existe **relación vigente** y la **sede del contexto** está entre sus asignaciones. Director: existe **autorización de lectura** vigente para ese paciente.
5. **Se registra la auditoría antes de entregar el dato.** Cualquier negativa en 2-4 se audita como acceso clínico denegado.

---

## 4. Flujos

**4.1 Apertura de la historia.** Al asignar un odontólogo o al primer registro clínico se crea la historia (número correlativo). Se **advierte** si no hay consentimiento clínico vigente (decisión: no bloquear).

**4.2 Asignar relación asistencial.** Recepción/administración/Director selecciona paciente y odontólogo → se crea la relación (origen `ASSIGNMENT`). Si el odontólogo abre una visita sin relación → **autoasignación con motivo** → relación `SELF_ASSIGNED` marcada para revisión. Una **derivación** la crea un odontólogo con relación vigente, con motivo.

**4.3 Antecedentes (anamnesis).** El odontólogo registra antecedentes por categoría; cambiar uno crea una **versión nueva con motivo**; lo resuelto se marca `RESOLVED`.

**4.4 Alergias y alertas.** Se registra la **evaluación de alergias** (no evaluado / sin alergias conocidas / con alergias) y cada alergia con severidad; las graves aparecen como **alerta derivada** en la cabecera de la ficha. Las alertas clínicas manuales se crean y revisan con versiones.

**4.5 Visita.** El odontólogo abre una visita (sede del contexto, motivo de consulta) → registra **diagnósticos** y **procedimientos** → redacta la **evolución** → cierra la visita. Una visita puede cancelarse con motivo antes de tener evoluciones cerradas.

**4.6 Evolución versionada.**

```
Borrador (solo su autor, editable) ──► [Reautenticación] ──► CERRADA (inmutable, hash)
                                                                │
         ┌──────────────────────── corrección (autor) ◄────────┘
         ▼  con motivo + reautenticación
   Versión 2 CERRADA   (la v1 sigue visible y comparable)
         │
         └─► "Ingresado por error" (motivo + reautenticación): la versión permanece visible, tachada
```

- Un borrador no leído por nadie más; descartarlo lo marca `DISCARDED` (no se borra).
- El texto de reautenticación es explícito: **"Confirma que usted realiza esta acción. No es una firma legal ni digital."**
- Otro odontólogo con relación agrega un **adendo** vinculado; no edita la nota ajena.

**4.7 Lectura por asistente.** Ve la *vista de apoyo* de pacientes con relación vigente en su sede; cualquier otra lectura es denegada y auditada.

**4.8 Acceso excepcional `clinical:read_all`.** El Director elige paciente → declara **categoría y motivo** → se crea la autorización (30 min) y se audita → lee solo ese paciente; cada lectura se audita con referencia a la autorización → vencida o sin motivo, **denegado**.

**4.9 Acceso denegado.** Respuesta 403/404 sin revelar contenido; se registra el intento. (Cambio respecto del incremento 2, donde los denegados no se auditaban.)

---

## 5. API propuesta (borrador; todo bajo `/v1`, sin implementar)

| Ruta | Permiso |
|---|---|
| `GET /patients/:id/clinical-record` (resumen: alertas, alergias, antecedentes, últimas visitas; limitado para asistente) | `clinical:read` / `read_limited` / `read_all` |
| `GET/POST /patients/:id/care-team` · `POST …/:relId/end` · `POST …/:relId/review` | `care:assign` (+ revisión: Director) |
| `GET/POST /patients/:id/clinical/backgrounds` · `POST …/:itemId/versions` · `GET …/:itemId/versions` | `clinical:read` / `clinical:write` |
| `GET/POST /patients/:id/clinical/allergies` · `POST …/:itemId/versions` · `POST /patients/:id/clinical/allergy-assessment` | ídem |
| `GET/POST /patients/:id/clinical/alerts` · `POST …/:itemId/versions` | ídem |
| `GET/POST /patients/:id/visits` · `GET …/:visitId` · `POST …/:visitId/close` · `POST …/:visitId/cancel` | ídem |
| `GET/POST /visits/:visitId/diagnoses` · `POST …/:itemId/versions` | ídem |
| `GET/POST /visits/:visitId/procedures` · `POST …/:itemId/versions` | ídem |
| `GET/POST /visits/:visitId/notes` · `PATCH …/:itemId` (solo borrador) · `POST …/:itemId/close` · `POST …/:itemId/corrections` · `POST …/:itemId/mark-error` · `POST …/:itemId/discard` · `GET …/:itemId/versions` | `clinical:read` / `clinical:write` |
| `POST /auth/reauthenticate` (`purpose`, `targetId`, contraseña → token de 2 min, un solo uso) | autenticado |
| `POST /patients/:id/clinical-access` (categoría + motivo → autorización 30 min) · `GET /clinical-access/report` | `clinical:read_all` |

Convenciones heredadas: UUID, paginación acotada, validación estricta (`forbidNonWhitelisted`), respuestas por campo (sin *spread* de entidades), 404 uniforme para lo ajeno, `reason` obligatorio en cambios sensibles.

---

## 6. Auditoría

| Evento | Datos |
|---|---|
| `CLINICAL_RECORD_VIEWED` y lecturas por sección | usuario, paciente, sede, fecha, IP, user agent, secciones, vía de acceso (relación o autorización) |
| Altas y revisiones de antecedentes, alergias, alertas, diagnósticos, procedimientos | acción, entidad, `item_id`, **versión**, motivo; **sin contenido clínico** |
| `VISIT_OPENED` / `CLOSED` / `CANCELLED` | usuario, visita, sede, motivo |
| `NOTE_CLOSED` / `NOTE_CORRECTED` / `NOTE_MARKED_ERROR` / `NOTE_DISCARDED` | usuario, nota, versión, motivo, `reauth_event` |
| `NOTE_VERSIONS_VIEWED` | usuario, nota, versiones comparadas |
| `CARE_RELATIONSHIP_*` | quién, a quién, origen, motivo, marca de revisión |
| `CLINICAL_ACCESS_DENIED` | usuario, paciente (si es de su clínica), regla que falló |
| `CLINICAL_READ_ALL_GRANTED` / `…_READ` | usuario, paciente, fecha, **IP**, user agent, **categoría y motivo**, secciones |
| `DIRECTOR_ROLE_GRANTED` / `REVOKED` | quién, a quién, motivo, referencia de autorización |
| `REAUTH_SUCCEEDED` / `FAILED` | usuario, propósito |

Reglas: inmutable; en la **misma transacción** en escrituras y **antes de entregar el dato** en lecturas (falla cerrada); sin contenido clínico, contraseñas ni tokens; consulta de la auditoría clínica restringida (no basta `audit:read`: el administrador ve metadatos, no la actividad clínica detallada **[por validar]**); retención indefinida **[por validar]**.

---

## 7. Criterios de aceptación

**Acceso y aislamiento**
1. Plataforma y administrador de clínica reciben **403** en todo endpoint clínico (con y sin contexto de clínica).
2. Recepción y caja reciben **403** en todo endpoint clínico; recepción puede asignar relación sin ver contenido.
3. Un odontólogo **sin relación** recibe denegación y queda auditado; **con relación pero en una sede no asignada**, también.
4. Un asistente ve **solo** la vista de apoyo; todo intento de crear, editar, cerrar o corregir recibe 403.
5. Un paciente de otra clínica responde 404 igual que uno inexistente, en **todos** los endpoints, incluidos `visits`, `notes` e hijos.
6. Un odontólogo no puede acceder a elementos de un paciente cambiando el `visitId`/`itemId` de la URL.

**`clinical:read_all`**
7. Solo el rol Director Clínico (o administrador al que se le asignó también ese rol) lo posee; ningún otro rol lo recibe, **ni siquiera si lo otorga plataforma**.
8. Sin categoría y motivo (≥ 10 caracteres) no hay autorización; con ella, la lectura vale 30 min y solo para ese paciente.
9. Cada autorización y **cada lectura** generan auditoría con **usuario, paciente, fecha, IP, user agent, categoría y motivo**; si la auditoría falla, **no se entrega el dato**.
10. `clinical:read_all` **no permite escribir** nada.
11. Nadie puede otorgarse el rol a sí mismo; otorgar/revocar queda auditado con motivo y referencia.

**Versionado e inmutabilidad**
12. Antecedentes, alergias, alertas, diagnósticos y procedimientos: corregir crea una **versión nueva** con motivo obligatorio; la anterior permanece visible; el historial es consultable.
13. Hay **una sola** versión vigente por elemento (restricción de BD) y `UPDATE`/`DELETE` directos sobre versiones son rechazados por la BD.
14. Una evolución en **borrador** solo la ve y edita su autor; no aparece en listados de terceros.
15. **Cerrar** una evolución exige reautenticación válida (un solo uso, 2 min); un token vencido, reutilizado o de otro usuario/objetivo es rechazado.
16. Una evolución **cerrada** no se puede editar (API ni SQL directo); corregirla crea la versión 2 con motivo y reautenticación; la v1 se conserva.
17. **"Ingresado por error"** conserva la versión, la marca visible y exige motivo + reautenticación.
18. **Nada** de lo clínico se elimina físicamente (probado por SQL directo).
19. La pantalla/API muestra siempre que el cierre es una **reautenticación, no una firma**.

**Visitas y contenido**
20. Una visita requiere sede dentro de las asignaciones del odontólogo; no se puede cerrar con borradores abiertos (se cierran o se descartan).
21. Diagnósticos y procedimientos pertenecen a una visita y a un paciente de la clínica; los dientes se validan como numeración FDI.
22. La **evaluación de alergias** distingue "no evaluado" de "sin alergias conocidas"; una alergia grave genera la alerta derivada.
23. Registrar sin consentimiento clínico vigente devuelve **advertencia** (no bloquea).

**Auditoría y datos**
24. Toda lectura y escritura clínica genera un registro con usuario, paciente, sede, fecha, IP, user agent y (si aplica) motivo y versión; **ningún registro contiene texto clínico**.
25. Los accesos clínicos **denegados** se auditan.
26. Ningún dato clínico sale a Apiworking ni a *logs* (verificado por pruebas de contenido de *logs* y auditoría).
27. Rendimiento: ficha clínica de un paciente con 500 elementos en ≤ 500 ms (consultas paginadas e índices).

**Calidad**
28. Migración desde cero en MySQL 8.4, `migrate diff` sin desvío, seed ficticio reproducible, pruebas unitarias y e2e (matriz de roles completa), lint, typecheck y build en verde, documentación actualizada.

---

## 8. Estrategia de pruebas

- **Matriz e2e rol × acción × relación × sede × clínica** (positivos y negativos), incluida la plataforma con y sin contexto.
- **Pruebas de regresión de seguridad**: cambiar IDs de la URL, tokens de reautenticación manipulados/vencidos, intentos de autoasignación sin motivo, escalada por otorgar roles.
- **Pruebas de BD**: triggers de inmutabilidad y no-borrado, FK compuestas, `current_key` único, CHECK de motivos y cierres.
- **Pruebas de auditoría**: presencia de IP/usuario/paciente/motivo y **ausencia** de contenido clínico; falla cerrada si la auditoría falla.
- **Pruebas de contenido de respuestas**: sin rutas internas, sin campos de otras clínicas.

---

## 9. Plan de entrega por sub-incrementos

| # | Contenido | Compuerta de salida |
|---|---|---|
| **3.0** ✅ | **Hecho** ([`incremento-3-0-acceso-seguro.md`](incremento-3-0-acceso-seguro.md)): aprovisionamiento por **invitación** que reemplaza la excepción de plataforma; **reautenticación**; **refresh token/logout**; regla de **último administrador/Director**; rol Director. **Completado:** **recuperación de contraseña**, **deshabilitación/reactivación** de usuarios, **mantenimiento** (depuración) y auditoría de **accesos denegados**. Pendiente antes de datos reales: notificación de contraseña cambiada, canal de entrega probado, respaldos | Plataforma ya no otorga roles de clínica; 368 pruebas e2e; sin fugas de secretos |
| **3.1** ✅ | **Hecho** ([`incremento-3-1-acceso-clinico.md`](incremento-3-1-acceso-clinico.md)): **relación asistencial**, permisos `clinical:*` y `care:assign`, `clinical:read_all` con justificación + reautenticación + auditoría previa, vista de apoyo del asistente, protección del Director y mitigaciones de escalamiento. `clinical_record` y el modelo clínico se crean con 3.2 | Matriz de acceso completa verde (431 e2e) |
| **3.2** ✅ | **Hecho** ([`incremento-3-2-antecedentes-alertas.md`](incremento-3-2-antecedentes-alertas.md)): antecedentes, alergias y alertas (derivadas y manuales) versionados, sobre el motor de 3.1; abstracción de cifrado de campos preparada. **Parche 3.2.1** ([`incremento-3-2-1-parche.md`](incremento-3-2-1-parche.md)): evaluación de alergias versionada y motivo opcional en el alta. Política para 3.3: consentimiento clínico faltante no bloquea diagnóstico ni visita, sí el cierre de procedimientos configurados "requiere consentimiento" | Versionado e inmutabilidad probados en BD (482 e2e) |
| **3.3** ✅ | **Hecho** ([`incremento-3-3-visitas-diagnosticos-procedimientos.md`](incremento-3-3-visitas-diagnosticos-procedimientos.md)): visitas con máquina de estados, diagnósticos y procedimientos versionados, catálogo por clínica con `requiresClinicalConsent` (bloquea solo el cierre del procedimiento) | Reglas de sede, visita y consentimiento probadas (514 e2e) |
| **3.4** ✅ | **Hecho** ([`incremento-3-4-evoluciones.md`](incremento-3-4-evoluciones.md)): evolución por visita (borrador editable → cerrada con reautenticación → corregida), ficha de atención en una lectura y datos demo ficticios. **Pendiente:** adendos de otro profesional | Criterios 14-19 (545 e2e) |
| **3.5** ✅ | **Odontograma** hecho ([`incremento-3-5-odontograma.md`](incremento-3-5-odontograma.md)): estructura por pieza/superficie/estado, versionado e inmutable, exportación PDF/SVG y especificación visual para el panel. **Pendiente (siguiente):** informe de usos de `clinical:read_all`, endurecimiento, rendimiento, restauración de respaldo con datos clínicos | Criterios 24-28 (570 e2e) |

Orden recomendado: **3.0 → 3.1 → 3.2 → 3.3 → 3.4 → 3.5**. No se cargan datos reales hasta cerrar 3.0 y validar los puntos normativos críticos. Después: **3b** adjuntos clínicos y el **incremento 4** (odontograma).

---

## 10. Preguntas normativas y legales por validar

No se asume ninguna exigencia ni plazo; todo lo siguiente requiere revisión con un asesor competente:

1. **Norma técnica vigente de historia clínica** (MINSA u otra): contenido mínimo obligatorio (filiación, anamnesis, examen, diagnóstico, plan, evolución…), formato, numeración y quién puede escribir y firmar.
2. **Historia clínica electrónica y firma:** ¿una evolución electrónica requiere **firma digital o electrónica** con valor legal? (La reautenticación **no** lo es.) ¿Aplican obligaciones de **registro/interoperabilidad** de historias clínicas electrónicas?
3. **Codificación:** sistema oficial de diagnósticos (p. ej. CIE-10) y de procedimientos odontológicos exigidos.
4. **Conservación y custodia:** plazo, responsable, y destino si la clínica cierra o cambia de proveedor.
5. **Rectificación y derechos del paciente:** cómo se concilian acceso, copia y rectificación con una historia **inmutable y versionada**.
6. **Datos de salud como datos sensibles:** base legal, consentimiento específico, registro del banco de datos, medidas de seguridad exigidas, transferencia a un proveedor de infraestructura y notificación de incidentes.
7. **Quién puede acceder legalmente** (auditoría interna, ente supervisor, otro profesional, familiares) y cómo se documenta.
8. **Director Clínico:** existencia y responsabilidad de la figura; si el acceso excepcional debe tener otra denominación o aprobación.
9. **Menores:** representación y consentimiento para registrar y tratar; mayoría de edad y capacidad intermedia.
10. **Adendos y correcciones:** forma admisible de enmendar una historia (¿quién puede, con qué constancia?).
11. **Cifrado y respaldo:** exigencias específicas para datos de salud.
12. **Ubicación del almacenamiento:** si existen restricciones de residencia de datos para el VPS y los respaldos externos.
13. **Retención de la auditoría** y quién puede consultarla.
14. **Odontología específica:** requisitos propios del registro odontológico (odontograma, evolución, consentimientos por procedimiento) para planificar el incremento 4.
