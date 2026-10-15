# Sub-incremento 3.4: evoluciones narrativas clínicas

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15). **No** incluye odontograma, planes de tratamiento, presupuestos, agenda ni facturación, y **no** hay recomendaciones automáticas, IA ni decisiones clínicas. Lo normativo/legal sigue **[por validar]**.

Reutiliza sin excepciones el motor de acceso clínico de 3.1 (relación asistencial, vista del asistente, `clinical:read_all` del Director), la auditoría previa a la lectura, la versión optimista y el patrón versionado. Pantalla de destino y flujo: [`../diseno/ficha-de-atencion.md`](../diseno/ficha-de-atencion.md).

## 1. La evolución

Una evolución **por visita**: `body` (relato, ≤ 10 000) y `followUp` (indicaciones y seguimiento, opcional, ≤ 2 000). Estados visibles para la clínica:

| Estado visible | Interno | Significado |
|---|---|---|
| **Borrador** | `DRAFT` | Trabajo en curso del odontólogo responsable. Se edita en el sitio |
| **Cerrada** | `CLOSED` | Confirmada con reautenticación. Inmutable |
| **Corregida** | `CLOSED` + último cambio `CORRECTED`/`RECTIFIED` | Una cerrada que tuvo una corrección o rectificación |
| Descartada | `DISCARDED` | Un borrador que se dejó de usar (se conserva) |
| Registrada por error | `ENTERED_IN_ERROR` | Una cerrada marcada como error (se conserva) |

### Flujo
1. **Escribir** — `PUT …/visits/:visitId/evolution` `{ body, followUp?, expectedEtag? }`: **crea** el borrador la primera vez (`201`) y lo **actualiza en el sitio** después (`200`). Un solo paso, sin "crear" separado. Idempotente: guardar lo mismo no cambia nada ni se audita de nuevo. El `etag` (`"versión.revisión"`) viene en cada respuesta; si otra pestaña cambió el borrador, `409 VERSION_CONFLICT` con el `currentEtag` (nada del contenido).
2. **Cerrar** — `POST …/evolution/close` `{ expectedEtag, password }` (un paso) **o** `{ expectedEtag, reauthToken }` (prueba emitida antes por `POST /auth/reauthenticate`, propósito `CLOSE_CLINICAL_NOTE`, objeto = id de la evolución). Crea una **versión nueva inmutable** (la del borrador queda en el historial) con **huella de integridad SHA-256**, fecha y el id de la prueba consumida.
3. **Corregir o rectificar** — `POST …/evolution/correct|rectify` `{ expectedEtag, reason, body?, followUp?, password|reauthToken }`: versión **nueva, enlazada a la anterior** (`supersedes`), con **motivo obligatorio** y reautenticación (`CORRECT_CLINICAL_NOTE`). *Corregir* arregla un error de registro; *rectificar* actualiza o aclara la información. Debe cambiar algo. Vale también con la visita ya cerrada.
4. **Descartar** un borrador — `…/evolution/discard` `{ expectedEtag, reason }`. **Registrar por error** una cerrada — `…/evolution/mark-error` `{ expectedEtag, reason, password|reauthToken }` (`MARK_CLINICAL_NOTE_ERROR`). Ambas conservan el historial y permiten redactar otra evolución.
5. **Leer** — `GET …/evolution` (la activa o `null`) y `…/evolution/versions` (todas las versiones de la última evolución, de la más nueva a la más vieja).

### "Cerrar" no es firmar
La reautenticación **confirma que quien tiene la sesión conoce la contraseña ahora**. **No es una firma digital, legal ni clínica.** La respuesta lo declara siempre (`closure.isSignature = false`, `closure.notice`, `reauth.notice`) y la pantalla debe mostrarlo. La huella de integridad es evidencia técnica de que el texto no cambió, no una firma. Ver la limitación normativa en la sección 8.

### Una evolución cerrada no se edita ni se borra
La API responde `409 NOT_A_DRAFT` ante un `PUT`. En la base de datos, triggers impiden `DELETE`, impiden modificar cualquier versión escrita, impiden reabrir una reemplazada, y solo permiten editar un **borrador** que sigue vigente (relato, seguimiento y contador de revisión). Cerrar o corregir sin huella, fecha y reautenticación es imposible, y también lo son las transiciones inválidas (borrador→error, cerrada→borrador) y los cambios sin motivo (salvo el cierre).

## 2. Reglas con la visita y el odontólogo
- Solo el **odontólogo responsable** de la visita, **en la sede de la visita**, escribe, cierra o corrige; otro odontólogo con relación **lee** lo cerrado (`403 NOT_VISIT_RESPONSIBLE` si intenta escribir).
- **El borrador es privado:** los demás lectores autorizados (otro odontólogo, Director con autorización) ven que existe (`contentHidden: true`) pero **no su texto**.
- La evolución se **redacta y cierra con la visita abierta**. La visita **no se cierra con un borrador** (`409 OPEN_NOTE`) ni **se cancela con una evolución vigente** (`409 HAS_NOTES`); también lo impone la base de datos.
- Una sola evolución activa (borrador o cerrada) por visita: creaciones simultáneas → una prospera.

## 3. Quién accede (mismo motor de 3.1)
| Perfil | Evolución |
|---|---|
| Odontólogo responsable | Escribe, cierra, corrige (con reautenticación) |
| Otro odontólogo con relación vigente | Lee lo cerrado; no ve el borrador; no escribe |
| Asistente | **Nada** (`403 CLINICAL_LIMITED_VIEW`); solo alertas |
| Director con `clinical:read_all` y autorización por paciente | Solo lectura (lo cerrado); nunca escribe |
| Administración, recepción, caja, plataforma | `403` genérico idéntico exista o no el paciente |
| Otra clínica | `404` idéntico a un id inexistente |

## 4. Ficha de atención (una sola lectura)
`GET /v1/patients/:id/clinical/visits/:visitId/sheet` — pensada para **una sola pantalla**. Orden: **alertas** → paciente/alergias/consentimiento → visita → **diagnósticos** → **procedimientos** → **evolución** → acciones disponibles → etiquetas. Una lectura = **una** auditoría previa (sección `visit_sheet`). Incluye textos en lenguaje de la clínica (`labels`, `statusLabel`, `certaintyLabel`…), el aviso **previo** de consentimiento en cada procedimiento (`closeBlockedByConsent`, `closeBlockedMessage`) y las **acciones** que quien mira puede hacer (`actions`), para que la pantalla no deduzca permisos. Contrato campo por campo en el documento de diseño.

## 5. Auditoría (sin contenido narrativo)
`CLINICAL_NOTE_{CREATED,DRAFT_SAVED,CLOSED,CORRECTED,RECTIFIED,DISCARDED,MARKED_IN_ERROR}` (en la misma transacción) con `itemId`, `visitId`, versión, revisión, **nombres** de campos y, al cerrar/corregir, `reauthenticated: true, isSignature: false`; más `REAUTH_CONSUMED`/`REAUTH_REJECTED` y las lecturas (`CLINICAL_RECORD_VIEWED` / `CLINICAL_READ_ALL_READ`, secciones `evolution`, `evolution_versions`, `visit_sheet`) y denegaciones (`CLINICAL_ACCESS_DENIED`, p. ej. `reauthentication_failed`, `not_visit_responsible`). **Nunca** el relato, el seguimiento, el motivo ni la contraseña. El id de la prueba (no el token) queda en la versión cerrada como evidencia. Probado: ni auditoría, ni búsquedas, ni listados, ni errores, ni logs contienen el texto. Si la auditoría falla: la lectura da `503` sin datos y la escritura se revierte (incluido el consumo de la prueba).
> Cada guardado del borrador se audita (referencia y campos). El panel debe **guardar con calma** (p. ej. al dejar de escribir unos segundos), no en cada tecla.

## 6. Concurrencia (probada)
Guardados simultáneos con el mismo etag (uno prospera); cierres simultáneos; cerrar mientras se guarda (lo cerrado coincide exactamente con lo guardado antes, o los cierres ven un etag viejo y piden releer); correcciones simultáneas; creaciones simultáneas; cerrar la visita mientras se crea el borrador (nunca queda un borrador en una visita cerrada); y revocar la relación, retirar el rol o deshabilitar al odontólogo mientras escribe (ninguna escritura posterior a la baja).

## 7. Datos de demostración (ficticios)
`npm run db:seed` (solo desarrollo) crea el equipo y la atención de **Clínica Demo**, todo ficticio: ver el documento de diseño (cuentas, pacientes y estados). Sin personas, DNI, teléfonos, correos, fotografías, direcciones ni historias reales; correos `@apidental.test` (dominio reservado); documentos `9000000x`; textos marcados como "demostración". La prueba `demo-seed.e2e-spec.ts` recorre el flujo completo con esos datos y verifica que todo texto sembrado esté marcado como ficticio.

## 8. Riesgos y puntos por validar
**Normativos / legales:** (1) si la **confirmación con contraseña** basta para una evolución clínica o se exige **firma** (digital, manuscrita o sello/colegiatura) y **hora certificada**; hoy NO se afirma que sea firma; (2) contenido mínimo y formato de una evolución y de su historia clínica; (3) validez de corregir/rectificar frente a la **inmutabilidad** y qué debe mostrarse al paciente; (4) derecho del paciente a acceder a la evolución y a copias; (5) conservación y custodia; (6) quién puede leer evoluciones ajenas (hoy: otros odontólogos con relación vigente, no los borradores).
**Técnicos / de producto:** el relato es texto libre y puede contener cualquier dato clínico; **sin cifrado por campo** (requisito efectivo: cifrado del volumen, respaldos externos y secretos; ver 3.2); **sin traspaso de la visita** a otro odontólogo; **sin adendos** de otro profesional a una evolución ajena; **sin plantillas ni dictado**; el cierre con contraseña implica que quien conoce la contraseña puede cerrar (política de contraseñas y bloqueo ya existentes); un guardado de borrador por cada pausa genera filas de auditoría (por diseño); la huella de integridad no se verifica automáticamente (hay que recalcular y comparar).

## 9. Condiciones previas a datos reales (sin cambios)
Canal de entrega probado, respaldo diario externo con restauración verificada, cifrado de volumen y respaldos, gestión segura de secretos y revisión legal.
