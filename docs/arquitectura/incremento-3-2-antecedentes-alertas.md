# Sub-incremento 3.2: antecedentes, alergias y alertas clínicas

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15); ajustado por el [parche 3.2.1](incremento-3-2-1-parche.md) (evaluación de alergias y motivo del alta). Primer contenido clínico real del sistema. **No** incluye diagnósticos, procedimientos, visitas, evoluciones, odontograma ni presupuestos. Todo lo normativo/legal sigue **[por validar]**.

Se apoya en [`incremento-3-1-acceso-clinico.md`](incremento-3-1-acceso-clinico.md): **cada** lectura y escritura pasa por `ClinicalAccessService` (no hay otra vía a estas tablas).

## 1. Qué se registra

### 1.1 Antecedentes y alergias (`clinical_history_entries`)
Texto estructurado de **apoyo administrativo**, sin catálogos rígidos ni guía médica:

| Campo | Notas |
|---|---|
| `kind` | `BACKGROUND` (antecedente) o `ALLERGY` (alergia). No cambia entre versiones |
| `label` | Antecedente o agente alérgeno (2–200, texto libre) |
| `condition` | Condición o reacción (≤ 300, opcional) |
| `category` | Etiqueta libre (≤ 60, opcional). `GET /v1/clinical/options` sugiere valores, **sin validar contra ellos** |
| `severity` | `NOT_SPECIFIED` · `MILD` · `MODERATE` · `SEVERE`: gravedad **referencial declarada por el profesional**, no calculada |
| `status` | `ACTIVE` · `INACTIVE` · `ENTERED_IN_ERROR` |
| `isCritical` | Si está activo, **genera una alerta derivada** |
| `onsetDate` | Fecha (opcional, no futura) |
| `source` | `PATIENT` · `GUARDIAN` · `DOCUMENT` · `PROFESSIONAL` · `OTHER` |
| `observations` | ≤ 1000 |

### 1.2 Alertas manuales (`clinical_alerts`)
`severity` (`INFO`/`WARNING`/`CRITICAL`), `text` (≤ 300, breve: lo ve también el asistente), `source` (origen), `expiresAt` (vigencia opcional, debe ser futura) y el motivo de cada versión. Las alertas **derivadas** (de alergias/antecedentes críticos activos) **no se almacenan**: se calculan al leer, así nunca quedan desincronizadas.

**Las alertas son informativas.** No toman decisiones clínicas ni bloquean tratamientos o agenda; las respuestas lo declaran (`advisory: true`).

## 2. Trazabilidad: versiones, motivo y sin borrado

Patrón de **elemento versionado**: una fila por versión; `item_id` identifica el elemento; **una sola vigente** (`current_key` único).

| Acción | Endpoint | Efecto |
|---|---|---|
| Alta | `POST …/history` · `…/alerts` | Versión 1 (`CREATED`) |
| Corrección | `…/:itemId/correct` | Arregla un **error de registro** → versión nueva (`CORRECTED`) |
| Rectificación | `…/:itemId/rectify` | **Actualiza o rectifica** la información → versión nueva (`RECTIFIED`) |
| Desactivación | `…/:itemId/deactivate` | `ACTIVE → INACTIVE` (`DEACTIVATED`) |
| Reactivación | `…/:itemId/reactivate` | `INACTIVE → ACTIVE` (`REACTIVATED`) |
| Ingresado por error | `…/:itemId/mark-error` | → `ENTERED_IN_ERROR`, terminal (`MARKED_IN_ERROR`) |
| Historial | `…/:itemId/versions` | Todas las versiones, con tipo de cambio, motivo, autor y **nombres** de campos modificados |

- **Motivo:** obligatorio (≥ 3 caracteres) en corrección, rectificación, desactivación, reactivación e "ingresado por error"; **opcional en el alta** (la fuente sí es obligatoria). *Ajustado en el parche 3.2.1* ([`incremento-3-2-1-parche.md`](incremento-3-2-1-parche.md)). Lo exigen la API y un trigger.
- **Concurrencia optimista:** cada cambio envía `expectedVersion`; si otra persona cambió el registro, `409 VERSION_CONFLICT` (con solo el número de versión actual, nada del contenido). Dos cambios simultáneos se serializan con un bloqueo de la versión vigente: **exactamente uno prospera**.
- **Sin eliminación física, ni reescritura:** triggers impiden `DELETE`, impiden modificar cualquier columna de una versión escrita (solo se permite **soltar** la marca de vigente al ser reemplazada), validan que cada versión continúe a la anterior **del mismo elemento, paciente y clínica**, y que la versión 1 sea el alta. FK compuestas impiden cruzar clínicas.
- Un paciente inactivo no admite registros nuevos. Un registro `ENTERED_IN_ERROR` no admite cambios, pero **se conserva y se puede consultar**.

## 3. Quién ve qué (siempre vía el motor de 3.1)

| Perfil | Antecedentes/alergias | Versiones | Alertas | Escritura |
|---|---|---|---|---|
| Odontólogo con relación vigente | Sí | Sí | Sí, completas (`FULL`) | Sí (sede de origen) |
| Asistente (vista de apoyo) | **No** (`403 CLINICAL_LIMITED_VIEW`) | **No** | **Solo activas y mínimas** | No |
| Director con autorización `read_all` | Sí (lectura) | Sí | Sí | **No** |
| Administración, recepción, caja, plataforma | No | No | No | No |

**Vista mínima del asistente** (por alerta): `id`, `origin` (`ALLERGY`/`BACKGROUND`/`MANUAL`), `severity`, `label` (la etiqueta breve) y `validUntil`. **No** recibe observaciones, condición, motivos, fuente, versión, estado ni alertas inactivas/vencidas. Tampoco ve alergias o antecedentes no críticos. Esta definición está **[por validar con Clínica Demo]**.

Sin permiso clínico: `403` genérico igual exista o no el paciente. Otra clínica o paciente inexistente: `404` idéntico (también con ids de elementos ajenos). Ver 3.1.

## 4. Auditoría (sin contenido clínico)

| Evento | Acción |
|---|---|
| Lectura (lista, detalle, alertas, versiones) | `CLINICAL_RECORD_VIEWED` / `CLINICAL_READ_ALL_READ` **antes** de entregar, con la sección (`history`, `history_versions`, `alerts`, `alert_versions`) |
| Autorización de escritura | `CLINICAL_WRITE_AUTHORIZED` |
| Cambios | `CLINICAL_ENTRY_{CREATED,CORRECTED,RECTIFIED,DEACTIVATED,REACTIVATED,MARKED_IN_ERROR}` y `CLINICAL_ALERT_…`, **en la misma transacción** |
| Denegaciones | `CLINICAL_ACCESS_DENIED` (motivo, sin revelar existencia) |

El resumen guarda: `itemId`, `version`, tipo de elemento, tipo de cambio, **nombres de campos afectados** y la vía de acceso. **Nunca** etiquetas, condiciones, observaciones, textos de alerta ni motivos. Si la auditoría de una lectura falla → `503` sin datos; si la de una escritura falla → se revierte todo.

Tampoco aparecen en: búsquedas de pacientes, ficha demográfica, duplicados, relaciones asistenciales, consentimientos, `GET /audit-logs`, mensajes de error ni logs (verificado con un registrador que captura todo).

## 5. Concurrencia con la revocación de acceso
Una escritura **revalida la relación asistencial dentro de su transacción con un bloqueo compartido** (`FOR SHARE`), y la revocación toma el bloqueo exclusivo: o la revocación se confirma antes (la escritura se deniega, `403`) o la escritura se confirma antes (era válida). **Nunca existe una escritura posterior a una revocación confirmada.** Probado con revocación de relación, retiro de rol y deshabilitación simultáneos a escrituras.

## 6. Seguridad de datos

### 6.1 Requisito EFECTIVO antes de datos reales (obligatorio)
**Los textos clínicos se guardan en claro en MySQL.** La protección efectiva exigida antes de cargar pacientes reales es:
1. **Cifrado del volumen** donde residen la base de datos y el directorio de adjuntos (p. ej. LUKS/dm-crypt o cifrado del proveedor), con la clave fuera del propio disco.
2. **Respaldos externos cifrados** con restauración verificada (y sus claves gestionadas aparte).
3. **Gestión segura de secretos:** `JWT_ACCESS_SECRET`, credenciales de base de datos, secreto del webhook y claves de cifrado fuera del repositorio, en archivo con permisos 600 o gestor de secretos; rotación documentada; usuario de aplicación distinto del de migraciones.
Sin esto, no hay datos reales (junto con el canal de entrega probado y la revisión legal de 3.1).

### 6.2 Abstracción de cifrado por campo (preparada, **no activa**)
`src/common/crypto/field-cipher.ts`: interfaz `FieldCipher`, implementación **AES-256-GCM** con el **contexto** `tabla|columna|clínica|fila` como dato autenticado (un valor copiado a otra fila o clínica no descifra), formato autodescriptivo con identificador de clave y **rotación** (se cifra con la activa; se descifra con cualquiera del llavero). Config: `FIELD_ENCRYPTION_MODE=off|aes-gcm` (por defecto `off`), `FIELD_ENCRYPTION_KEY_ID`, `FIELD_ENCRYPTION_KEY` (32 bytes en base64), `FIELD_ENCRYPTION_OLD_KEYS`. Se inyecta como `FIELD_CIPHER`. **Ningún servicio ni columna la usa en 3.2** (probado: el cifrador está apagado y el texto se guarda en claro).
Para activarla en el futuro: cifrar al guardar y descifrar al leer en los servicios, migrar los datos existentes, y asumir que **un campo cifrado no se puede buscar ni filtrar** (por eso `label`/`category` no deberían cifrarse si se necesitan consultas). La pérdida de la clave implica pérdida del dato: exige respaldo de claves.

## 7. Pendiente sobre la separación de "dos personas"
La separación (quien otorga un rol clínico no asigna pacientes a esa cuenta) **se mantiene**. Para clínicas muy pequeñas, el **futuro flujo de excepción debe exigir aprobación explícita y auditoría reforzada**, nunca suprimir la separación. Propuesta a diseñar y validar: un Director (o el representante legal de la clínica) aprueba por escrito, con reautenticación, la asignación puntual; queda un registro específico de excepción, con vigencia corta y revisión posterior.

## 8. Riesgos y puntos normativos por validar

**Normativos / legales (todos [por validar] con asesor legal y Clínica Demo):**
1. Marco aplicable a **datos de salud** (datos sensibles) y a la **historia clínica** en Perú: qué se considera historia clínica, qué antecedentes/alergias deben constar, formato, plazo de conservación y custodia.
2. Si el **registro de un antecedente por parte del odontólogo** exige firma, identificación del profesional (colegiatura) o sello, y cómo se vincula con estos registros (hoy: usuario autenticado, no firma).
3. **Rectificación y supresión** (derechos del titular) frente a la inmutabilidad: hoy se rectifica creando versiones y se "retira" con `ENTERED_IN_ERROR`; el dato original se **conserva**. Debe confirmarse que esto es admisible y qué responder a una solicitud de eliminación.
4. **Acceso del paciente** a su información y entrega de copias.
5. Si la **fuente** (`PATIENT`/`GUARDIAN`…) y el uso de **representante** para menores requieren formalidades adicionales.
6. Tratamiento de **terceros con acceso técnico** (operadores del VPS/proveedor) y cláusulas de confidencialidad.
7. Si el **cifrado de volumen + respaldos** es suficiente o se exige cifrado por campo (la capa está lista).
8. La retención indefinida de las versiones y de la auditoría.

**Técnicos / de producto:**
- ~~Alergias sin "evaluación"~~ **Resuelto en el parche 3.2.1** (`NOT_ASKED` / `NO_KNOWN_ALLERGIES` / `ALLERGIES_RECORDED`, versionado).
- **El texto es libre:** el sistema no valida que sea correcto, ni evita datos clínicos en campos no previstos (p. ej. el **motivo** del cambio y el texto de la alerta). El motivo de cada versión es contenido clínico visible solo para quien lee el historial; **no** va a la auditoría.
- **Sin alertas automáticas** a quien agenda o a quien cobra: hoy las alertas solo se ven en el resumen y en `/clinical/alerts` con permiso clínico (decisión de producto: no mostrarlas a perfiles administrativos).
- **Sin búsqueda por contenido** clínico (por diseño).
- La vista del asistente muestra la **etiqueta** de la alergia crítica (necesaria para el apoyo operativo): se considera mínima **[por validar]**.
- **Sin informe periódico** de lecturas con `read_all` ni alertas ante accesos denegados reiterados (3.5).
- **Deshabilitar un registro no notifica** a otros profesionales que atienden al paciente.
- La corrección "sin cambios" se rechaza (400), pero **dos correcciones secuenciales idénticas** crean versiones (comportamiento esperado).

## 9. Endpoints (todos bajo `/v1`)
| Ruta | Permiso de ruta | Decisión real |
|---|---|---|
| `GET /clinical/options` | cualquier `clinical:*` de lectura | — (valores sugeridos de apoyo administrativo) |
| `GET/POST /patients/:id/clinical/history` | lectura clínica / `clinical:write` | `FULL` o `READ_ALL` (lista); `FULL` (alta) |
| `GET /patients/:id/clinical/history/:itemId` · `/versions` | lectura clínica | `FULL` o `READ_ALL` |
| `POST …/history/:itemId/{correct,rectify,deactivate,reactivate,mark-error}` | `clinical:write` | `FULL` + relación vigente (sede de origen) |
| `GET /patients/:id/clinical/alerts` (`?includeInactive=true` solo nivel completo) | lectura clínica | `FULL`, `READ_ALL` o `LIMITED` |
| `POST /patients/:id/clinical/alerts` · `…/:itemId/{correct,deactivate,reactivate,mark-error}` | `clinical:write` | `FULL` |
| `GET …/alerts/:itemId/versions` | lectura clínica | `FULL` o `READ_ALL` |
| `GET /patients/:id/clinical-summary` | (3.1) | Ahora incluye `clinicalAlerts` (mínimas para el asistente) |

## 10. Para iniciar 3.3 (visitas, diagnósticos y procedimientos)
1. Reutilizar el mismo patrón: `authorize` → auditoría previa → transacción con `assertStillAuthorized` y registro de auditoría en la misma transacción.
2. Aplicar el bloqueo de procedimientos configurados como "consentimiento obligatorio" con `clinicalConsentStatus` (hasta hoy solo alerta).
3. Decidir cómo se vinculan diagnósticos/procedimientos con alergias críticas **sin** convertir las alertas en reglas automáticas, salvo decisión explícita.
4. Habilitar las fuentes `APPOINTMENT`/`VISIT` de la relación asistencial cuando existan agenda y visitas.
