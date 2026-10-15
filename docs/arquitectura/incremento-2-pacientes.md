# Incremento 2: pacientes, contactos, consentimientos y adjuntos privados

Complementa a [`mvp-p0-apidental.md`](mvp-p0-apidental.md) y a [`incremento-1-fundacion.md`](incremento-1-fundacion.md). Describe lo **realmente implementado**.

Convención: lo marcado **[por validar]** no es un hecho normativo ni legal; es una decisión provisional.

## Alcance

**Incluido:** pacientes por clínica, identificadores (DNI, CE, pasaporte), datos demográficos y contacto, detección de posibles duplicados (sin fusión), representantes/apoderados, consentimientos separados (clínico, fidelización, marketing), adjuntos administrativos privados, auditoría de lectura y escritura, permisos por clínica/sede/rol. Solo API; sin interfaz.

**Excluido (a propósito):** antecedentes médicos, alergias, diagnósticos, evoluciones, tratamientos, odontograma, citas; firma digital o manuscrita; integración con Apiworking; almacenamiento externo tipo S3; **cualquier eliminación física** de pacientes o adjuntos; fusión de pacientes.

La fundación (tenancy, RBAC, JWT, auditoría) no se reestructuró. Solo se extendió: columna `patient_id` en la auditoría, siete permisos nuevos y una excepción documentada en la regla anti-escalada (ver "Decisiones").

## Modelo de datos

| Entidad | Rol |
|---|---|
| `patients` | Identidad (`id` UUID inmutable), clínica, nombres, nacimiento (`DATE`), sexo, estado, sede de registro, autor. |
| `patient_identifiers` | DNI/CE/pasaporte con historial (`ACTIVE`/`SUPERSEDED`), motivo del cambio. |
| `patient_contacts` | Celular, teléfono, correo, dirección, con historial; marca de principal. |
| `guardians` | Representante o apoderado (persona), reutilizable entre hermanos. |
| `patient_guardians` | Vínculo paciente-representante: parentesco, principal, representante legal, vigencia. |
| `patient_consents` | Un registro por consentimiento: tipo, estado, documento y versión, fecha, quién lo otorgó, revocación. |
| `attachments` | Solo metadatos (tipo detectado, tamaño, SHA-256, clave de almacenamiento, baja lógica). El contenido está en disco. |

Reglas de integridad aplicadas **en la base de datos** (comprobadas en MySQL 8.4):

- **Identidad inmutable:** un trigger impide cambiar `patients.id` y `patients.clinic_id`.
- **Aislamiento:** todas las tablas hijas llevan `clinic_id` y una FK compuesta `(patient_id, clinic_id) → patients(id, clinic_id)`; es imposible asociar datos de una clínica a un paciente de otra, aun por SQL directo. Igual para `patient_guardians → guardians`.
- **Sin borrado físico:** triggers `BEFORE DELETE` en pacientes, identificadores, contactos, representantes, vínculos, consentimientos y adjuntos.
- **Consentimiento como registro legal:** un trigger bloquea cambiar tipo, documento, versión, fecha y quién otorgó; y reactivar un consentimiento revocado.
- **Adjunto inmutable:** un trigger bloquea cambiar hash, clave, tamaño, tipo, nombre y dueño, y revertir una baja lógica.
- **Unicidad de lo vigente** mediante columnas `*_key` que son `NULL` cuando el registro deja de estar vigente (MySQL ignora los `NULL` en índices únicos): documento vigente único por clínica, un identificador vigente por tipo y paciente, un contacto principal por tipo, un consentimiento vigente por tipo.
- **Celular y correo no son únicos** entre pacientes (se comparten y cambian).

## Reglas de dominio

- **Identificadores.** DNI: exactamente 8 dígitos (dato confirmado). CE y pasaporte: 6-20 caracteres alfanuméricos, formato **[por validar]**. Único por clínica (si existe); el mismo número puede existir en otra clínica. Reemplazarlo exige motivo y conserva el anterior como historial.
- **Duplicados.** Identificador vigente repetido → **409** (`IDENTIFIER_CONFLICT`, con el paciente existente) y no se crea nada. Coincidencias de nombre, nacimiento, celular o correo → solo **advertencia** (`duplicateWarnings`), sin bloquear ni fusionar:

  | Coincidencia | Confianza |
  |---|---|
  | Nombre + fecha de nacimiento | `HIGH` |
  | Nombre + celular/correo, o solo correo | `MEDIUM` |
  | Solo nombre, o solo celular (compartido entre familiares) | `LOW` |

  La comparación no distingue mayúsculas ni tildes (colación `utf8mb4_unicode_ci`: "José" = "JOSE"). Disponible al crear, al cambiar nombre/nacimiento o un contacto, por `duplicate-check` (sin escribir), por paciente y como reporte de la clínica.
- **Menores.** Se considera menor a quien tiene menos de 18 años (calculado en America/Lima; la mayoría de edad y la capacidad de consentir de 14-17 años: **[por validar]**). Un menor sin representante activo muestra la advertencia `MINOR_WITHOUT_GUARDIAN` (no bloquea el alta). El consentimiento de un menor solo lo otorga un representante **vigente y vinculado a ese paciente**.
- **Consentimientos.** Tres tipos independientes (`CLINICAL`, `LOYALTY`, `MARKETING`). Uno vigente por tipo; para registrar una nueva versión se revoca el anterior. Revocar exige motivo, no borra ni edita el registro. El documento firmado se carga como adjunto de categoría `CONSENT` vinculado al consentimiento. **Formatos, validez legal y plazos: [por validar].** No hay firma digital ni manuscrita.
- **Cambios con motivo.** Obligatorio al reemplazar DNI/CE/pasaporte, cambiar o dar de baja celular y correo, revocar un consentimiento, dar de baja un adjunto, finalizar un vínculo de representante y desactivar/reactivar un paciente. Opcional para nombre/nacimiento y dirección.
- **Baja lógica.** Pacientes (`INACTIVE`), contactos, identificadores, vínculos y adjuntos se dan de baja sin eliminarse. Un paciente inactivo no se edita ni recibe consentimientos o adjuntos nuevos, pero sus consentimientos sí pueden revocarse.
- **Sede.** El paciente pertenece a la clínica y se atiende en todas sus sedes. `createdBranchId` es solo informativo.

## Permisos (política **temporal** hasta definir la historia clínica)

| Permiso | Admin clínica | Recepción | Odontólogo | Asistente | Cajero | Admin plataforma |
|---|---|---|---|---|---|---|
| `patient:read_basic` (identificación y contacto) | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| `patient:read` (ficha completa, representantes, duplicados) | ✔ | ✔ | ✔ | ✔ | — | — |
| `patient:write` (crear/editar paciente, identificadores, contactos, representantes) | ✔ | ✔ | — | — | — | — |
| `consent:read` | ✔ | ✔ | ✔ | ✔ | — | — |
| `consent:write` | ✔ | ✔ | — | — | — | — |
| `attachment:read` (listar y descargar) | ✔ | ✔ | ✔ | ✔ | — | — |
| `attachment:write` (cargar y dar de baja) | ✔ | ✔ | — | — | — | — |

- **Administrador de plataforma:** ningún permiso sobre pacientes, y además `clinicScope()` exige un contexto de clínica: aunque algún día recibiera un permiso por error, seguiría sin acceso. Cualquier acceso excepcional futuro deberá ser justificado y auditado.
- **Cajero:** solo la vista mínima (nombre, documentos, celular y correo principales). No ve nacimiento, sexo, dirección, representantes, consentimientos ni adjuntos.
- La vista de la respuesta depende del permiso, no solo de la ruta, y se construye campo por campo (nunca con spread de la entidad).
- Un paciente de otra clínica responde **404** igual que uno inexistente.

## Endpoints (`/v1`, requieren JWT y contexto de clínica)

**Pacientes**

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `POST /patients` | `patient:write` | Alta. 201 con `patient`, `duplicateWarnings`, `warnings`. 409 si el documento ya existe. |
| `POST /patients/duplicate-check` | `patient:write` | Verifica duplicados sin escribir. |
| `GET /patients/duplicate-report` | `patient:read` | Grupos de posibles duplicados de la clínica. |
| `GET /patients` | `patient:read_basic` | Búsqueda: `identifier`, `identifierType`, `name`, `phone`, `email`, `birthDate`, `status`, `limit`, `offset`. |
| `GET /patients/:id` | `patient:read_basic` | Ficha (completa o mínima según permiso). |
| `PATCH /patients/:id` | `patient:write` | Edita datos demográficos. |
| `POST /patients/:id/deactivate` · `/reactivate` | `patient:write` | Baja/alta lógica, con motivo. |
| `GET /patients/:id/duplicates` | `patient:read` | Posibles duplicados de un paciente. |
| `PUT /patients/:id/identifiers` | `patient:write` | Alta o reemplazo de un identificador. |
| `POST /patients/:id/contacts` | `patient:write` | Agrega contacto. |
| `PATCH /patients/:id/contacts/:contactId` | `patient:write` | Reemplaza el valor (historial). |
| `POST /patients/:id/contacts/:contactId/retire` | `patient:write` | Da de baja el contacto. |

**Representantes:** `GET /guardians?search=` (`patient:read`), `GET|POST /patients/:id/guardians` (`patient:read` | `patient:write`), `POST /patients/:id/guardians/:linkId/end` (`patient:write`).

**Consentimientos:** `GET /patients/:id/consents` (`consent:read`), `POST /patients/:id/consents` y `POST …/:consentId/revoke` (`consent:write`).

**Adjuntos:** `POST /patients/:id/attachments` (multipart: `file`, `category`, `description?`, `consentId?`) y `POST …/:attachmentId/remove` (`attachment:write`); `GET /patients/:id/attachments[?includeRemoved=true]` y `GET …/:attachmentId/download` (`attachment:read`; `includeRemoved` solo lo respeta si además se tiene `attachment:write`).

**Auditoría:** `GET /audit-logs?patientId=` (`audit:read`) muestra la trazabilidad de un paciente dentro de la clínica.

## Adjuntos privados

- **Ubicación.** Directorio `ATTACHMENTS_DIR` (absoluto y obligatorio en producción), fuera de cualquier ruta servida. Nombre en disco = UUID aleatorio (el nombre original solo vive en la BD, saneado y solo para mostrar); permisos `0700`/`0600`; creación exclusiva (`wx`, nunca sobrescribe). No se guarda contenido en MySQL.
- **Sin URL pública.** La API es el único camino: JWT + contexto + permiso + auditoría. La clave de almacenamiento y las rutas **nunca** salen en respuestas (ni en errores). Se comprobó que ninguna ruta adivinada (`/files/…`, `/storage/…`, `/uploads/…`) devuelve el archivo.
- **Validación.** El tipo se detecta por los **bytes iniciales** (PDF, JPEG, PNG, WebP); el `Content-Type` declarado debe coincidir (si no, 415). Se rechazan ejecutables, HTML, SVG, ZIP y scripts aunque se declaren como imagen o PDF. Vacío → 422; mayor a `ATTACHMENT_MAX_BYTES` (10 MiB por defecto) → 413. Un archivo idéntico (mismo hash, paciente y categoría) no se carga dos veces.
- **Integridad.** Se registra el SHA-256 al cargar y **se verifica en cada descarga**; si el archivo en disco difiere, no se entrega (500 genérico y registro del incidente).
- **Descarga.** `Content-Disposition: attachment` con `filename*` UTF-8, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. La descarga se **audita antes** de entregar el archivo.
- **Sin borrado.** `LocalFileStorage` no tiene ningún método de borrado (lo prueba un test). La baja es lógica (`REMOVED`, con motivo y autor): el archivo y el registro permanecen y dejan de ser descargables.
- **Categorías.** Solo administrativas: `CONSENT`, `IDENTITY_DOCUMENT`, `OTHER_ADMINISTRATIVE`. Las radiografías y fotos clínicas llegarán con el módulo clínico y permisos propios.
- **Consistencia.** El archivo se escribe como último paso dentro de la transacción: si falla, se revierte el registro. Si fallara el `COMMIT` tras escribir, quedaría un archivo huérfano inocuo (UUID sin referencia).

## Auditoría

Acciones nuevas: `PATIENT_CREATED/VIEWED/SEARCHED/UPDATED/DEACTIVATED/REACTIVATED`, `PATIENT_IDENTIFIER_CHANGED`, `PATIENT_CONTACT_ADDED/CHANGED/RETIRED`, `PATIENT_GUARDIAN_LINKED/UNLINKED`, `PATIENT_GUARDIANS_VIEWED`, `PATIENT_DUPLICATES_VIEWED`, `PATIENT_DUPLICATE_REPORT_VIEWED`, `CONSENT_GRANTED/REVOKED/LISTED`, `ATTACHMENT_UPLOADED/LISTED/DOWNLOADED/REMOVED`.

- Las **lecturas** se auditan (ficha, búsqueda, listados, descargas) con usuario, clínica, sede, paciente, IP y user agent. Las escrituras se auditan **en la misma transacción** que el cambio; si la auditoría falla, la operación falla.
- Como `audit_logs` es inmutable, **no copia datos personales**: los cambios de DNI, celular y correo guardan valores **enmascarados** (últimos 3 caracteres; correo `a***@***.pe`) y el motivo; los cambios de nombre/nacimiento guardan solo los nombres de los campos; las búsquedas guardan qué filtros se usaron y cuántos resultados, nunca los valores. El historial completo está en las tablas de dominio.
- Los accesos denegados (401/403/404) **no** generan registro de acceso (ver pendientes).

## Decisiones tomadas

1. **Regla anti-escalada con excepción (RETIRADA en el sub-incremento 3.0).** En este incremento la plataforma podía otorgar roles de clínica para incorporar clínicas, una vía indirecta de acceso. Se **sustituyó** por invitaciones de un solo uso donde la persona define su propia contraseña; ver [`incremento-3-0-acceso-seguro.md`](incremento-3-0-acceso-seguro.md).
2. **Historial en tablas de dominio, enmascarado en auditoría** (ver arriba), para no volver inmutables datos personales.
3. **Vista según permiso**, no según ruta, para que el cajero use las mismas rutas con menos datos.
4. **Desactivar un paciente exige motivo** y lo excluye de la búsqueda por defecto (`status=INACTIVE` lo recupera).
5. **MIME por contenido** y sin dependencia externa (firmas de 4 formatos).
6. **Nombre de archivo UTF-8:** Multer interpreta el nombre en latin1 por defecto y corrompía tildes; se fija `defParamCharset: 'utf8'` (hallado por las pruebas).
7. **Representante duplicado:** si ya existe uno con el mismo documento, se responde 409 sugiriendo reutilizarlo (no se duplica en silencio).

## Pendientes y riesgos

- **Normativa [por validar]:** formatos y validez de consentimientos, mayoría de edad y capacidad de menores, conservación indefinida, formato de CE/pasaporte, registro de banco de datos personales y régimen de acceso de la plataforma. Nada de esto se afirma como cumplido.
- **Sin antivirus** sobre los adjuntos. Se mitiga limitando a 4 tipos, validando por contenido y sirviendo como descarga con `nosniff`. Un PDF puede contener contenido activo para quien lo abra.
- **Sin cifrado en reposo** a nivel de aplicación; se recomienda cifrar el volumen/directorio del VPS y asegurar que `ATTACHMENTS_DIR` esté en los respaldos diarios externos (si no, un respaldo solo de MySQL deja registros sin archivos).
- **Archivos en memoria durante la carga** (hasta `ATTACHMENT_MAX_BYTES` por solicitud concurrente): conviene acotar la concurrencia en producción (límite de Nginx y del throttler ya presentes).
- **Auditar accesos denegados:** desde 3.0 los `403` de usuarios autenticados se auditan como `ACCESS_DENIED` (patrón de ruta, sin ids). Los `404` por paciente ajeno **siguen sin auditarse** (decisión: evitar ruido; revisar en 3.1).
- **Búsqueda por nombre** con `LIKE '%…%'` (no usa índice). Adecuado para clínicas pequeñas; evaluar `FULLTEXT` o prefijos si crece.
- **Sin editar datos de un representante** ni consultar el historial de identificadores/contactos por API (los datos se conservan en las tablas).
- **Sin fusión de pacientes** (por diseño); la resolución de duplicados confirmados queda para un incremento posterior.
- Recuperación de contraseña y refresh token **resueltos en 3.0**; la política de administrador de clínica sobre la historia clínica sigue abierta (ver incremento 1). Siguen siendo requisitos previos a usuarios reales.
- **El listado sin filtros** devuelve pacientes paginados; si se quiere impedir el volcado masivo, exigir al menos un filtro.

## Verificación (2026-10-14, MySQL Community 8.4.6)

| Comprobación | Resultado |
|---|---|
| Migración `20261014010000_patients_and_attachments` desde cero y sin desvío con el schema | Correcta |
| Seed idempotente con 4 pacientes ficticios, 1 representante y 3 consentimientos | Correcto |
| Pruebas unitarias | 59 de 59 |
| Pruebas e2e (11 archivos), dos corridas consecutivas | **170 de 170** |
| `tsc --noEmit`, `oxlint --type-aware`, `nest build` | Sin errores ni avisos |
| `npm audit` | 0 vulnerabilidades |
| Prueba real por HTTP con la API compilada (login, contexto, búsqueda, carga multipart, descarga idéntica, URL pública, baja lógica, auditoría) | Correcta |

Cobertura específica pedida: aislamiento entre clínicas; duplicado por DNI (409) y advertencias por nombre/nacimiento/celular/correo; permisos por rol (matriz completa, incluida la plataforma); auditoría de lectura y modificación sin datos personales; adjuntos sin URL pública; descarga denegada (sin JWT, sin permiso, sin contexto, plataforma, otra clínica) sin filtrar datos; validación de MIME por contenido, tamaño y hash (incluida la alteración en disco); baja lógica sin eliminación física (registro, archivo y triggers); y que rutas internas y hashes no aparezcan en respuestas no autorizadas.
