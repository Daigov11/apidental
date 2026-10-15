# Sub-incremento 3.3: visitas, diagnósticos y procedimientos clínicos

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15). **No** incluye evoluciones narrativas, odontograma, planes de tratamiento, presupuestos, agenda ni facturación. Todo lo normativo/legal sigue **[por validar]**.

Se apoya en 3.1 (motor de acceso, relación asistencial) y 3.2 (patrón versionado): **todas** las lecturas y escrituras pasan por `ClinicalAccessService`, con auditoría previa a la entrega, versión optimista y revalidación de la relación bajo bloqueo compartido. Política de consentimiento decidida en el [parche 3.2.1](incremento-3-2-1-parche.md).

> **Los registros son declaraciones del profesional.** Un diagnóstico o un procedimiento NO es una recomendación, un protocolo ni una decisión clínica automática: el sistema no sugiere, no deduce y no bloquea nada por su contenido. Las respuestas lo declaran (`declaredByProfessional: true`).

## 1. Catálogo de procedimientos por clínica

`procedure_definitions`: `code` (interno de la clínica, mayúsculas, único por clínica), `name`, `description`, **`requiresClinicalConsent`**, `status` (`ACTIVE`/`INACTIVE`) y `version`. **No es un nomenclador ni una guía clínica**: cada clínica define los suyos. Nunca se borra (se desactiva) y el código no cambia.

- Permisos: `procedure:manage` (administración y Director) para configurar; `procedure:read` (además, odontólogos) para consultar. Recepción, caja, asistente y plataforma, no.
- Cada cambio exige `expectedVersion` y motivo (`409 VERSION_CONFLICT` si cambió), y se audita como `PROCEDURE_DEFINITION_{CREATED,UPDATED,DEACTIVATED,REACTIVATED}` con versión, **nombres** de campos, el valor vigente del indicador de consentimiento y el motivo (es configuración de la clínica, no dato de pacientes).
- Un procedimiento registrado **copia** código y nombre de la definición: el historial no cambia si el catálogo se edita después. Una definición inactiva no admite registros nuevos (los abiertos pueden cerrarse). Una definición ajena o inexistente: `404` uniforme.
- Rutas: `GET/POST /v1/procedure-definitions` · `PATCH /:defId` · `POST /:defId/deactivate|reactivate`.

## 2. Visita clínica (`clinical_visits`)

Paciente, clínica, **sede**, **odontólogo responsable**, fecha, estado (`OPEN`/`CLOSED`/`CANCELLED`), **motivo administrativo** (opcional; no debe contener datos clínicos), **relación asistencial** que la amparó, número correlativo por paciente, `appointmentId` reservado para la agenda y `version`.

- **Abrir** (`POST …/clinical/visits`): odontólogo con relación vigente, **sede en el contexto** (`400` si no hay) y paciente activo. Una visita **abierta** por paciente y odontólogo (`409 VISIT_ALREADY_OPEN`). **Nunca se bloquea por consentimiento**: la respuesta incluye `warnings` (`CLINICAL_CONSENT_MISSING`/`REVOKED`).
- **Estados:** `OPEN → CLOSED | CANCELLED`, **una sola vez**, con `expectedVersion` y bloqueo exclusivo de la fila. No se cierra con procedimientos abiertos (`409 OPEN_PROCEDURES`); no se cancela con procedimientos vigentes (`409 HAS_PROCEDURES`); cancelar exige motivo.
- **Inmutable:** su núcleo (paciente, sede, odontólogo, relación, número, motivo) no cambia; no se borra; una visita cerrada o cancelada no admite elementos nuevos (API y trigger).
- Solo el **odontólogo responsable** abre, cierra o cancela, y solo **desde la sede de la visita**; la lectura funciona desde cualquier sede de la clínica (continuidad asistencial).
- Rutas: `POST/GET …/clinical/visits` · `GET …/visits/:visitId` (con conteos) · `POST …/visits/:visitId/close|cancel`.

## 3. Diagnósticos (`clinical_diagnoses`) — versionados
`description` (≤ 500, texto libre), `code` opcional (texto libre, sin validar contra ningún sistema **[por validar]**), `certainty` (`PRESUMPTIVE`/`DEFINITIVE`) y `status`. Mismo patrón que 3.2: alta (`CREATED`), **corrección**, **rectificación**, desactivación, reactivación y **"ingresado por error"**, siempre con una versión nueva, `expectedVersion` y **motivo obligatorio en cada cambio** (el alta lo admite opcional, como en 3.2.1). Sin `DELETE`, sin reescritura, una sola vigente, FK compuesta a la visita, paciente y clínica.
- **Registrar un diagnóstico no depende del consentimiento.**
- Se registran en una visita **abierta** y por su responsable; corregir o rectificar un diagnóstico de una visita ya cerrada **es válido** (queda versionado), por el mismo responsable y en la sede de la visita.
- Rutas: `POST …/visits/:visitId/diagnoses` · `GET …/diagnoses[?visitId&status]` · `GET …/diagnoses/:itemId` · `…/versions` · `POST …/diagnoses/:itemId/{correct,rectify,deactivate,reactivate,mark-error}`.

## 4. Procedimientos realizados (`clinical_procedures`) — versionados
Tipo del catálogo (con copia de código y nombre), **odontólogo responsable** (el de la visita), `performedAt` (no futura), `notes` (≤ 1000), estado (`OPEN`/`CLOSED`/`CANCELLED`/`ENTERED_IN_ERROR`), `closedAt` y `closureConsent` (`NOT_REQUIRED`/`GRANTED`: evidencia de lo verificado al cerrar). Cambios: `CREATED`, `CORRECTED`, `RECTIFIED`, `CLOSED`, `CANCELLED`, `MARKED_IN_ERROR`; todos con `expectedVersion`, y **motivo obligatorio salvo en el alta y en el cierre** (cerrar es un evento normal del flujo, no una corrección).
- Corregir/rectificar (notas, fecha) vale con el procedimiento abierto **o cerrado** (versionado). Cerrado no se "reabre".
- Rutas: `POST …/visits/:visitId/procedures` · `GET …/procedures[?visitId&status]` · `…/:itemId` · `…/versions` · `POST …/procedures/:itemId/{correct,rectify,close,cancel,mark-error}`.

## 5. Consentimiento clínico (política decidida)

| Acción | ¿Se bloquea por consentimiento faltante? |
|---|---|
| Crear paciente, agendar (futuro) | **No** |
| **Abrir una visita** | **No** (solo `warnings`) |
| **Registrar un diagnóstico** (y corregirlo) | **No** |
| Registrar, planificar, corregir, cancelar o marcar por error un procedimiento | **No** |
| **Cerrar** un procedimiento cuya definición tiene `requiresClinicalConsent = true` | **Sí**, si no hay consentimiento clínico **vigente** (`GRANTED`) |
| Cerrar un procedimiento no obligatorio | No (`closureConsent = NOT_REQUIRED`) |

- **Vigente** = consentimiento de tipo `CLINICAL` en estado `GRANTED` (un consentimiento revocado, o de otro tipo —marketing, fidelización—, o de otro paciente, no cuenta).
- Se evalúa **al cerrar, con la configuración vigente del catálogo** en ese momento (cambiar el catálogo afecta a los procedimientos abiertos, no a los ya cerrados).
- **Concurrencia:** el cierre toma un bloqueo compartido sobre el consentimiento vigente; una revocación simultánea espera o gana, y el cierre ve su resultado. Además un **trigger** impone la regla (defensa en profundidad).
- **Respuesta:** `409 CLINICAL_CONSENT_REQUIRED` con `consentState` (`MISSING`/`REVOKED`). **Auditoría:** `CLINICAL_PROCEDURE_CLOSE_BLOCKED` con `itemId`, `visitId`, `definitionId`, versión y causa (`consent_missing`/`consent_revoked`); **sin** notas, diagnósticos ni nombre del procedimiento.
- **No hay excepciones de consentimiento** todavía. Un futuro flujo de excepción deberá exigir aprobación explícita y auditoría reforzada **[por validar]**.

## 6. Quién accede

| Perfil | Visitas / diagnósticos / procedimientos | Escritura |
|---|---|---|
| Odontólogo con relación vigente | Lee (cualquier sede de la clínica) | Solo si es el **responsable** de la visita y está en **su sede** |
| Otro odontólogo con relación | Lee | **No** (`403 NOT_VISIT_RESPONSIBLE`) |
| Asistente | **No** (`403 CLINICAL_LIMITED_VIEW`); solo alertas | No |
| Director con `clinical:read_all` y autorización por paciente | Solo lectura | **Nunca** |
| Administración, recepción, caja, plataforma | `403` genérico idéntico exista o no el paciente | No |

La vista del asistente se mantiene en **alertas**; no se agregó una "visita en curso" mínima. Si Clínica Demo la necesita, se diseñará aparte **[por validar]**.

## 7. Auditoría (sin contenido clínico)
`CLINICAL_VISIT_{OPENED,CLOSED,CANCELLED}`, `CLINICAL_DIAGNOSIS_{CREATED,CORRECTED,RECTIFIED,DEACTIVATED,REACTIVATED,MARKED_IN_ERROR}`, `CLINICAL_PROCEDURE_{CREATED,CORRECTED,RECTIFIED,CLOSED,CANCELLED,MARKED_IN_ERROR}`, `CLINICAL_PROCEDURE_CLOSE_BLOCKED` y `PROCEDURE_DEFINITION_*`, más las lecturas (`CLINICAL_RECORD_VIEWED` / `CLINICAL_READ_ALL_READ`, con la sección: `visits`, `diagnoses`, `diagnosis_versions`, `procedures`, `procedure_versions`) y las denegaciones (`CLINICAL_ACCESS_DENIED`, con motivos como `not_visit_responsible` o `wrong_branch`). Se guardan **referencias, versión y nombres de campos**; nunca descripciones, notas, motivos clínicos ni el motivo de la visita. Las escrituras se auditan en la misma transacción; si falla, se revierte. Tampoco aparecen en búsquedas, ficha, listados administrativos, errores ni logs (probado).

## 8. Concurrencia (probada)
Cambios simultáneos sobre la misma versión (una prospera), cerrar vs. cancelar un procedimiento, **revocar el consentimiento mientras se cierra**, **cerrar la visita mientras se registran diagnósticos o procedimientos** (nada queda abierto en una visita cerrada; bloqueo compartido de la visita para registrar y exclusivo para cerrar), **revocar la relación, retirar el rol o deshabilitar al odontólogo mientras escribe** (ninguna escritura posterior a la baja), aperturas simultáneas de visita (una sola) y cambios simultáneos del catálogo.

## 9. Riesgos y puntos por validar
**Normativos / legales:** (1) si los diagnósticos y procedimientos registrados cumplen los requisitos de una historia clínica (identificación y firma/colegiatura del profesional, hora, contenido mínimo); (2) uso de códigos de diagnóstico y de un nomenclador de procedimientos (hoy son texto libre / catálogo propio); (3) validez del consentimiento registrado y qué consentimiento específico corresponde a cada procedimiento (hoy un único consentimiento `CLINICAL`); (4) rectificación y conservación frente a la inmutabilidad; (5) menores y representantes en el consentimiento; (6) retención.
**Técnicos / de producto:** el motivo de la visita y las notas son texto libre (pueden contener datos clínicos; solo visibles con acceso autorizado, nunca en auditoría); un solo responsable por visita (no hay traspaso a un colega todavía); `appointmentId` y las fuentes cita/visita de la relación asistencial siguen reservadas; no hay evolución, plan de tratamiento ni presupuesto; sin excepciones de consentimiento; el asistente no ve nada de la visita; sin informe periódico de lecturas `read_all`.

## 10. Para iniciar 3.4 (evoluciones narrativas)
Reutilizar el patrón (autorizar → auditar → transacción con `assertStillAuthorized` y bloqueo de la visita), cierre de la evolución con reautenticación (`CLOSE_CLINICAL_NOTE`), correcciones versionadas y hash de integridad al cerrar; decidir cómo se vincula la evolución con diagnósticos y procedimientos sin automatizar decisiones.
