# Sub-incremento 6.1: odontograma de la visita (diagnóstico y post tratamiento)

**Estado:** implementado y probado contra MySQL 8.4 (2026-11-17). Es la fase 1 de digitalizar la ficha en papel de la clínica (`docs/integration/dental_a.pdf`). **No** incluye anamnesis ni examen clínico (6.2), CIE-10 (6.3), plan de tratamiento ni presupuesto (6.4), ni el registro de tratamientos con saldo (6.5). **Formato clínico por validar**: no cambia respecto de 3.5.

> Como en el papel, el odontólogo registra **cómo llega** el paciente (odontograma de diagnóstico) y **cómo sale** (odontograma post tratamiento). Al cerrar la visita, el último guardado pasa a ser el odontograma vigente del paciente.

## 1. Qué se registra
Tabla `clinical_visit_odontograms`. Cada visita tiene hasta **dos fases**:

| Fase | Parte de | Se usa para |
|---|---|---|
| `DIAGNOSIS` (diagnóstico) | La versión vigente del odontograma del paciente (3.5), o uno en blanco si es el primero | Registrar cómo llega |
| `POST_TREATMENT` (post tratamiento) | El diagnóstico **guardado** de la misma visita | Registrar cómo sale |

El contenido es **la misma estructura** del odontograma del paciente (`normalizeOdontogram`, misma dentición, mismos límites): no hay un formato nuevo.

## 2. Versionado
Cada fase es una cadena propia (`current_key = "visit_id|phase"`, una sola vigente por fase y visita):

| Transición | Quién | Condición |
|---|---|---|
| (nada o descartado) → **Borrador** | Odontólogo responsable de la visita, en su sede | Visita abierta. Post tratamiento: diagnóstico guardado |
| Borrador → **Guardado** | Ídem | Visita abierta. Huella SHA-256, sin reautenticación (como el primer guardado de 3.5) |
| Borrador → **Descartado** | Ídem | Motivo |
| Guardado → **Corregido** (guardado) | Ídem | Motivo **y reautenticación** (`CORRECT_VISIT_ODONTOGRAM`; no es una firma). También con la visita cerrada |

El borrador se edita en el sitio con `etag` (`versión.revisión`) y guardado automático. Un borrador ajeno se ve como "en curso", sin contenido.

## 3. Cierre y cancelación de la visita
- **No se cierra** con una fase en borrador (`OPEN_ODONTOGRAM`). La ficha lo avisa en `closeVisitBlockedBy`.
- **Al cerrar**, en la misma transacción (visita bloqueada y luego paciente bloqueado), la última fase guardada (post tratamiento; si no lo hay, diagnóstico) se **agrega a la cadena del paciente** como un borrador y su versión guardada (`UPDATED`, o `CREATED` si es el primero), con autor el odontólogo. Se audita `CLINICAL_ODONTOGRAM_CLOSED` con `source: visit`, `visitId` y `visitNumber`. Si el contenido es igual a la versión vigente, no se agrega nada. La respuesta trae `odontogramPromoted: { version } | null`.
- Si el paciente tiene un **borrador abierto en el odontograma general**, el cierre se rechaza (`PATIENT_ODONTOGRAM_DRAFT`): no se pisa trabajo en curso.
- **No se cancela** una visita con alguna fase en borrador o guardada (`HAS_ODONTOGRAM`). Un borrador se descarta y luego se cancela.
- **Corregir una fase con la visita ya cerrada no cambia el odontograma del paciente**: ese se corrige en su propia página (3.5).

La base de datos lo garantiza por su cuenta: triggers de la cadena (transiciones, motivo, huella, reautenticación, visita abierta, "el post tratamiento parte de un diagnóstico guardado"), inmutabilidad, no borrado, y `clinical_visits_guard_update` con las dos reglas nuevas.

## 4. Rutas (bajo `/v1/patients/:id/clinical/visits/:visitId/odontogram`)
| Método | Ruta | Qué hace |
|---|---|---|
| GET | `` | Ambas fases (con contenido salvo borradores ajenos) y acciones: `canStartDiagnosis`, `canStartPost`, `canCorrect` |
| GET | `/export` | PDF con las fases guardadas, sus hallazgos y las **piezas que cambiaron** |
| POST | `/:phase/draft` | Abre el borrador de la fase |
| PUT | `/:phase/draft` | Guarda el borrador (`data`, `dentition?`, `expectedEtag`) |
| POST | `/:phase/close` | Guarda la fase (`expectedEtag`) |
| POST | `/:phase/discard` | Descarta el borrador (`expectedEtag`, `reason`) |
| POST | `/:phase/correct` | Corrige una fase guardada (`expectedEtag`, `data`, `dentition?`, `reason`, `password` o `reauthToken`) |

La ficha (`…/sheet`) agrega `odontogram.phases` (estado, versión y fecha de cada fase, **sin dientes**).

## 5. Acceso y auditoría
Mismo motor de 3.1. Leer: secciones `visit_odontogram` y `visit_odontogram_export` (sin la vista limitada del asistente). Escribir: `clinical:write` y, dentro de la transacción, `assertVisitWriter` (odontólogo responsable y sede de la visita). Las negativas se auditan. La auditoría (`CLINICAL_VISIT_ODONTOGRAM_*`) guarda visita, fase, versión y nombres de campos; **nunca el contenido ni el motivo**. La exportación se audita **antes** de entregar el PDF y falla cerrada.

## 6. Pantalla
En la ficha de atención, la tarjeta **Odontograma** tiene pestañas **Diagnóstico | Post tratamiento | Comparar**. Se abre la fase en curso. Reutiliza el editor de 3.5, parametrizado con la ruta de la fase y un **modo corrección** (motivo y contraseña, sin guardado automático). **Comparar** dibuja ambos lado a lado y lista las piezas que cambiaron. El botón **Descargar PDF** aparece cuando hay alguna fase guardada.

## 7. Pruebas
- `apps/api/test/visit-odontogram.e2e-spec.ts` (11): fases y su origen, etag, descarte, solo el responsable, borradores ajenos ocultos, bloqueos de cierre y cancelación, promoción (con y sin cambios, primer odontograma), borrador general que bloquea, corrección con reautenticación, PDF, auditoría sin contenido y triggers.
- `odontogram-spec.spec.ts`: `diffOdontogram`.
- `apps/admin/test/visit-sheet.test.tsx`: pestañas, iniciar diagnóstico, comparar, aviso de bloqueo.

## 8. Riesgos y puntos por validar
- **[por validar]** Si el diagnóstico debe ser obligatorio para cerrar una visita. Hoy es opcional: una visita sin odontograma no cambia el del paciente.
- **[por validar]** Si la corrección de una fase con la visita cerrada debería proponer también corregir el odontograma del paciente. Hoy no lo hace.
- Las versiones de cada fase se ven en la auditoría; no hay todavía una pantalla de historial por fase.
- Los datos de demostración (`prisma/demo-*.ts`) no crean odontogramas de visita.
