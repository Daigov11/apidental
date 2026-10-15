# Sub-incremento 3.5: odontograma digital versionado y exportable

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15). **No** incluye planes de tratamiento ni presupuestos, y el sistema **no genera tratamientos, presupuestos ni diagnósticos, ni recomienda nada**. **Formato clínico por validar: no se afirma cumplimiento de normas del MINSA** hasta su validación formal. La política de reautenticación de las evoluciones (3.4) **no cambia**.

Reutiliza el motor de acceso de 3.1 (relación asistencial, vista del asistente, `clinical:read_all`), la auditoría previa, el patrón versionado y la reautenticación. Especificación visual para el panel React: [`../diseno/odontograma.md`](../diseno/odontograma.md).

## 1. Qué se registra
Una **cadena de versiones por paciente** (`clinical_odontograms`). El contenido es una **estructura por pieza** (numeración FDI), **superficies** y **estados**:

```json
{ "schema": "apidental.odontogram", "schemaVersion": 1,
  "teeth": { "16": { "surfaces": { "O": { "state": "CARIES", "note": "…" } } },
             "36": { "status": "ABSENT" },
             "46": { "marks": ["CROWN"] } },
  "notes": "…" }
```
- **Dentición:** `PERMANENT` (32 piezas), `PRIMARY` (20) o `MIXED` (52).
- **Estado de la pieza:** presente (por omisión), ausente, sin erupcionar, implante, resto radicular. **Superficies:** M, D, O, V, L, cada una con un hallazgo (caries, restauración, sellante, fractura, otro) y nota opcional. **Marcas:** corona, endodoncia, prótesis. Nota por pieza y notas generales (límites: 200 / 200 / 1000 caracteres; 60 KB).
- Son **registros de lo que el profesional observa o declara**. Ningún estado significa "indicado", "pendiente de tratar" ni "recomendado": la lista no contiene códigos de tratamiento. La lista de estados es de apoyo y puede cambiar al validar el formato (por eso `schemaVersion`).
- La API **valida y normaliza** (claves ordenadas, sin valores por defecto, texto recortado): lo igual tiene la misma huella. Rechaza campos desconocidos, piezas que no corresponden a la dentición, estados inexistentes y combinaciones incoherentes (superficies en una pieza ausente). **Los errores no repiten lo enviado.**

## 2. Versionado e inmutabilidad
| Estado visible | Significado |
|---|---|
| **Borrador** | Trabajo en curso del odontólogo que lo abrió. Se edita **en el sitio** (con `etag`) |
| **Guardada** | **Inmutable.** Con huella SHA-256 y fecha. Es una versión del odontograma |
| **Corregida** | Una guardada que es una corrección o rectificación |
| Descartada / Registrada por error | Terminales; se conservan |

- **Una versión guardada nunca se sobrescribe.** Cambiar algo abre un **borrador nuevo** (copia de la última guardada) y, al guardarlo, nace **otra versión** enlazada a la anterior (`supersedes`). La base de datos impide editar, reabrir o borrar una versión guardada.
- **Tipo de versión:** *Primer registro* (`CREATED`), *Actualización* (`UPDATED`: el estado de la boca cambió; motivo opcional), *Corrección* (`CORRECTED`: arregla un error de registro) y *Rectificación* (`RECTIFIED`: aclara o actualiza lo registrado). **Corrección y rectificación exigen motivo** (al abrir el borrador) **y reautenticación al guardar la versión**.
- **Versión vigente** = la última guardada que no se registró por error. **Registrar por error** una guardada exige motivo y reautenticación, la conserva y vuelve a regir la guardada anterior.
- Un solo borrador abierto a la vez. **Solo quien lo abrió** lo edita, guarda o descarta; los demás lectores autorizados ven que existe pero **no su contenido**.

### Reautenticación (no es una firma)
Confirma que quien tiene la sesión conoce la contraseña **ahora**, con la contraseña en el mismo paso (`password`) o una prueba previa (`reauthToken`; propósitos nuevos `CORRECT_ODONTOGRAM` y `MARK_ODONTOGRAM_ERROR`, objeto = el paciente, un solo uso, 2 minutos). **No es una firma digital, legal ni clínica**; las respuestas lo declaran. Guardar una **actualización** o el **primer registro** no exige reautenticación (decisión mía, ver riesgos): sí la exigen corregir, rectificar y registrar por error.

## 3. Flujo y rutas (todas bajo `/v1/patients/:id/clinical/odontogram`)
| Acción | Ruta |
|---|---|
| Ver estado | `GET /` → `{ official, draft, draftIsMine, versionsCount, formatNotice }` |
| Historial | `GET /versions` |
| Abrir borrador | `POST /draft` `{ purpose?, reason?, dentition? }` — sin propósito la primera vez (`201`); después `UPDATE`, `CORRECTION` o `RECTIFICATION` |
| Editar borrador | `PUT /draft` `{ data, expectedEtag, dentition? }` — reemplaza la estructura; guardar lo mismo no cambia nada; `409 VERSION_CONFLICT` con el `currentEtag` si cambió |
| Guardar la versión | `POST /close` `{ expectedEtag, password? \| reauthToken? }` (la reautenticación solo si es corrección o rectificación) |
| Descartar | `POST /discard` `{ expectedEtag, reason }` |
| Registrar por error | `POST /mark-error` `{ expectedEtag, reason, password \| reauthToken }` |
| Exportar | `GET /export?format=pdf\|svg&version=n` |
| Especificación visual | `GET /v1/clinical/odontogram/spec` |

## 4. Quién accede (mismo motor)
| Perfil | Odontograma |
|---|---|
| Odontólogo con relación vigente | Lee y exporta; abre/edita/guarda borradores (en la sede de origen de la relación) |
| Otro odontólogo con relación | Lee y exporta lo guardado; no ve ni toca el borrador ajeno |
| Director con `clinical:read_all` y autorización por paciente | **Solo lectura excepcional** (y exportación); nunca escribe |
| Asistente | **Sin acceso al detalle** (`403 CLINICAL_LIMITED_VIEW`) |
| Recepción, caja, administración, plataforma | `403` genérico idéntico exista o no el paciente |
| Otra clínica | `404` idéntico a un id inexistente |
La **ficha de atención** solo trae un resumen (versión guardada y si hay borrador), nunca el detalle.

## 5. Exportación
- **PDF** (A4, sin comprimir para poder archivarlo e inspeccionarlo): encabezado con el nombre de la **Clínica** (Demo en la demostración), aviso destacado **"FORMATO CLÍNICO POR VALIDAR"**, identidad del **paciente** (nombre, documento, nacimiento y edad), **versión** y estado, **fecha**, **profesional** (autor de la versión), dentición, motivo del cambio, el **dibujo** con patrones (legible en blanco y negro), leyenda, **hallazgos por pieza en texto**, notas generales y pie con fecha de generación, quien la generó, la **huella de integridad** y el aviso de que **no es una firma digital, legal ni clínica** ni incluye recomendaciones, tratamientos o presupuestos. El nombre del archivo no lleva datos personales (`odontograma-v4-2026-10-15.pdf`).
- **SVG**: el mismo dibujo, autónomo y accesible (cada pieza `id="tooth-<FDI>"`, `role="img"` y descripción); el texto del usuario va escapado (sin scripts).
- Solo se exporta una versión **guardada** y no registrada por error (`409` con un borrador o una versión anulada; `404` si no existe).
- **Se audita ANTES de entregar** (`CLINICAL_ODONTOGRAM_EXPORTED`: versión, formato y vía; nunca contenido); si no se puede registrar, `503` y no se entrega. Cabeceras `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`.
- Ejemplos con datos ficticios: [`../diseno/odontograma-demo.pdf`](../diseno/odontograma-demo.pdf) y [`../diseno/odontograma-demo.svg`](../diseno/odontograma-demo.svg) (generados con `node docs/diseno/tools/build-odontograma-demo.mjs`). Se agregó `pdfkit` 0.19.1 (exacta; sin vulnerabilidades conocidas).

## 6. Auditoría (sin contenido clínico)
`CLINICAL_ODONTOGRAM_{CREATED,DRAFT_STARTED,DRAFT_SAVED,CLOSED,DISCARDED,MARKED_IN_ERROR,EXPORTED}` con **versión, revisión, tipo de cambio y nombres de campos** (y, al guardar una corrección o registrar por error, `reauthenticated: true, isSignature: false`); más las lecturas (`CLINICAL_RECORD_VIEWED` / `CLINICAL_READ_ALL_READ`, secciones `odontogram`, `odontogram_versions`, `odontogram_export`) y las denegaciones. **Nunca** las piezas, superficies, notas, motivos ni la contraseña. Si la auditoría falla, la lectura da `503` sin datos y la escritura se revierte (incluido el consumo de la reautenticación). Probado: ni auditoría, ni búsquedas, ni listados, ni errores, ni logs contienen el contenido.

## 7. Concurrencia (probada)
Aperturas simultáneas de borrador (una prospera), guardados simultáneos con el mismo `etag`, guardar la versión dos veces a la vez o mientras se edita (el contenido guardado coincide exactamente con lo editado antes), guardados de una corrección simultáneos (la reautenticación se gasta una sola vez), descartar contra guardar, registrar por error varias veces, y **revocar la relación, retirar el rol o deshabilitar al odontólogo mientras edita o guarda** (ninguna escritura posterior a la baja). Todas las escrituras de la cadena de un paciente se serializan con el bloqueo del paciente y revalidan la relación bajo bloqueo compartido.

## 8. Datos de demostración (ficticios)
`npm run db:seed` (solo desarrollo): **Lucía Demo Adulta** con un odontograma **guardado y luego rectificado** (versión 4, *Corregida*: caries, restauraciones, sellante, fractura, ausente, sin erupcionar, endodoncia, corona e implante), **Mateo Demo Menor** con un odontograma de dentición **mixta en borrador** y **Jorge Demo Repetido** con uno **guardado** (cuatro muelas del juicio ausentes). Todo marcado como ficticio.

## 9. Riesgos y puntos por validar
**Normativos (todos [por validar]):** (1) **formato del odontograma según el MINSA** y la norma técnica de historia clínica (simbología, estados y colores oficiales, si la vigente exige un formato único); no se afirma cumplimiento; (2) si una **versión guardada con confirmación de contraseña** basta o se exige firma/sello del profesional y hora certificada; (3) validez de corregir/rectificar frente a la inmutabilidad; (4) entrega de copias al paciente (la exportación genera datos personales y clínicos); (5) conservación; (6) numeración FDI y representación para dentición mixta.
**Técnicos / de producto:** guardar una **actualización** o el primer registro no exige reautenticación (si prefiere exigirla siempre, es un cambio pequeño); el odontograma es **por paciente** y no está atado a una visita (la ficha muestra su resumen); sin **imágenes**, radiografías ni mediciones periodontales; sin **historial gráfico comparativo** entre versiones (se dibujan por separado); una versión anulada deja de regir y vuelve a regir la anterior (puede estar desactualizada: queda a criterio del profesional); la huella de integridad no se verifica automáticamente; PDF sin firma; la lista de estados es de apoyo; el estado "sin erupcionar" y las marcas no tienen aún semántica clínica validada; el texto de las notas es libre.

## 10. Condiciones previas a datos reales (sin cambios)
Canal de entrega probado, respaldo diario externo con restauración verificada, cifrado de volumen y respaldos, gestión segura de secretos y revisión legal (incluida la del formato del odontograma).
