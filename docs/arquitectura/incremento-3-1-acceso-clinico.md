# Sub-incremento 3.1: relación asistencial y control de acceso clínico

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15). **No hay datos clínicos todavía**: no existen antecedentes, alergias, diagnósticos, visitas, evoluciones ni odontograma. 3.1 entrega el **control de acceso** que esos módulos usarán desde su primera línea. Todo lo normativo/legal sigue **[por validar]**.

Complementa [`politica-acceso-clinico.md`](politica-acceso-clinico.md) (política adoptada) y [`incremento-3-0-acceso-seguro.md`](incremento-3-0-acceso-seguro.md).

## 1. Decisiones de producto aplicadas

| Decisión | Cómo queda |
|---|---|
| La relación asistencial existe mientras haya cita, visita o asignación vigente; se revoca con motivo y auditoría | Tabla `patient_care_relationships` con `source` (`ASSIGNMENT`; `APPOINTMENT` y `VISIT` reservadas), `valid_until` opcional, revocación con motivo y auditoría. Hoy solo se crea por **asignación**; las otras dos fuentes se rechazan hasta que existan agenda y visitas |
| El odontólogo lee lo que atendió en otras sedes de la misma clínica mientras siga asignado a la clínica | **Lectura:** cualquier relación vigente propia sirve en cualquier sede donde esté asignado. **Escritura:** exige la sede de origen de la relación (o una relación de toda la clínica) |
| El asistente solo ve alertas y datos de apoyo | `clinical:read_limited` → vista `LIMITED` (ver 4.3), de pacientes con relación vigente **en su sede** |
| El consentimiento clínico faltante alerta y, más adelante, bloqueará procedimientos configurados como obligatorios; no bloquea crear paciente ni agendar | Alerta `CLINICAL_CONSENT_MISSING`/`REVOKED` en la ficha, al crear y en el resumen. `consent-status.ts` es la función que usarán los módulos de procedimientos para bloquear |
| Plataforma, administración, recepción y caja sin acceso clínico | Ninguno tiene permisos `clinical:*` (probado en catálogo y e2e) |

## 2. Permisos y roles

| Permiso | Quién | Qué da por sí solo |
|---|---|---|
| `clinical:read` · `clinical:write` | **Odontólogo** | Nada: exige relación asistencial vigente |
| `clinical:read_limited` | **Asistente** | Nada: exige que el paciente esté en atención en su sede |
| `clinical:read_all` | **Solo Director Clínico** | Nada: exige autorización justificada de ese paciente. Solo lectura. Un **trigger** impide asociarlo a cualquier otro rol |
| `care:assign` | Administración, recepción, Director | Acto **administrativo**: asigna/revoca relaciones; no da lectura clínica a quien lo ejerce |

El Director **no** tiene `clinical:read`, `clinical:write` ni `patient:write`. La plataforma no tiene ninguno de los cinco.

## 3. Relación asistencial

`patient_care_relationships`: paciente, odontólogo, clínica, sede opcional (alcance), origen, vigencia, estado, creador, y al terminar: quién, cuándo, tipo (`REVOKED`/`EXPIRED`/`SYSTEM`) y motivo.

Garantías en la base de datos (triggers y FK):
- **FK compuestas** `(patient_id, clinic_id)` y `(branch_id, clinic_id)`: es imposible asociar un paciente o una sede de otra clínica.
- Una relación **nace activa**, su contenido es **inmutable**, solo puede **terminar** (una vez, con motivo ≥ 3 caracteres), **nunca se reabre ni se borra**.
- Una vigente por `(paciente, odontólogo, sede-o-toda-la-clínica)` (`active_key` único).

Reglas de la aplicación (`CareRelationshipsService`):
1. **Explícita y sin escalamiento entre clínicas:** el odontólogo debe tener un rol `DENTIST` vigente en esa clínica (y sede, si la relación es de una sede); si no, **404 uniforme** (no revela si el usuario existe en otra clínica).
2. **Separación de funciones:** nadie se asigna pacientes a sí mismo, y **quien otorgó el rol clínico** a una cuenta (`user_assignments.granted_by_id`) **no puede asignarle pacientes**. Lo debe hacer otra persona.
3. Un administrador limitado a una sede solo crea y revoca relaciones de esa sede.
4. **Cierre automático** (causa `SYSTEM`) al retirar el último rol de odontólogo de la clínica o al deshabilitar al usuario, bajo el mismo bloqueo de fila del usuario que usa la creación (no puede nacer una relación para quien está perdiendo el rol). **Reactivar no las restaura**: hay que volver a asignar.
5. **Vencimiento:** una relación con `valid_until` pasado deja de dar acceso al instante; el mantenimiento la cierra (`EXPIRED`) y lo informa (`expired.careRelationships`).

## 4. Motor de decisión (`ClinicalAccessService`)

Orden (falla cerrada; toda negativa se audita):
1. JWT válido y **contexto de clínica** (la plataforma queda fuera).
2. Permiso del módulo (si no tiene ninguno `clinical:*`: `403` genérico, sin tocar al paciente).
3. El paciente pertenece a la clínica → si no: **404 idéntico** al de un id inexistente.
4. Según el permiso: relación propia (odontólogo, `FULL`) → autorización read_all vigente (`READ_ALL`) → relación en su sede (asistente, `LIMITED`).
5. **Auditoría antes de entregar el dato.** Si no se puede escribir, `503` y no se entrega nada.

### 4.1 Superficie de 3.1
`GET /v1/patients/:id/clinical-summary` es la única superficie clínica: devuelve el nivel de acceso, las alertas derivadas y, para `FULL`/`READ_ALL`, un marcador `sections: NOT_AVAILABLE`. Los módulos futuros llaman a `authorize(actor, patientId, 'read'|'write', sections, meta)` y se enchufan ahí.

### 4.2 Códigos de respuesta (el panel debe mostrar la acción que corresponde)
| Situación | Respuesta |
|---|---|
| Paciente inexistente o de otra clínica | `404 Paciente no encontrado` |
| Sin permiso `clinical:*` | `403` genérico |
| Odontólogo/asistente sin relación | `403 NO_CARE_RELATIONSHIP` |
| Relación de otra sede para escribir | `403 WRONG_BRANCH` |
| Director sin autorización | `403 CLINICAL_JUSTIFICATION_REQUIRED` |
| Permiso no apto para la operación (p. ej. el asistente o el Director escriben) | `403 CLINICAL_PERMISSION_REQUIRED` |
| Reautenticación inválida/vencida/usada/de otro paciente | `403 REAUTHENTICATION_REQUIRED` |
| Auditoría no disponible | `503` |

Dentro de su propia clínica, un odontólogo que prueba ids distingue "mi paciente sin relación" (`403`) de "no existe" (`404`); ya puede buscar a esos pacientes en la ficha demográfica (pregunta abierta 12 de la política), así que no se agrega un `404` falso. Entre clínicas **no hay ninguna diferencia observable**.

### 4.3 Vista de apoyo del asistente
Solo: `access`, `patient {id, fullName, age, isMinor}`, `alerts` y `supportData {clinicalConsent}`. **Sin** fecha de nacimiento, sexo, secciones clínicas, diagnósticos ni evoluciones. El contenido de la vista de apoyo crece en 3.2–3.3 y sigue **[por validar con Clínica Demo]**.

## 5. `clinical:read_all` (Director Clínico)

`POST /v1/patients/:id/clinical-access` `{ category, reason, reauthToken }`:
- `category`: `CONTINUITY_OF_CARE` · `QUALITY_AUDIT` · `LEGAL_REQUEST` · `OTHER`. `reason`: **≥ 10 caracteres** (sin contar espacios de los extremos), ≤ 500. **El motivo va a la auditoría: no debe contener datos clínicos.**
- `reauthToken`: prueba de propósito `CLINICAL_READ_ALL` emitida **para ese paciente** (`targetId`), de un solo uso, 2 minutos. No es una firma.
- Crea `clinical_access_grants`: **un paciente, 30 minutos** (el tope lo impone un trigger), **atada a la sesión** que la pidió (cerrar sesión la invalida; otra sesión del mismo Director no la usa). **Solo se inserta** (inmutable, no se borra, no la depura el mantenimiento).
- El registro `CLINICAL_READ_ALL_GRANTED` (usuario, paciente, fecha, IP, user agent, categoría y motivo) se escribe **en la misma transacción**: si falla, no hay autorización **y la prueba de reautenticación no se gasta**.
- Cada lectura dentro de la ventana se audita como `CLINICAL_READ_ALL_READ` (con la autorización de origen) **antes** de entregarse. Expirada o para otro paciente: denegado y auditado.
- **Solo lectura** y **sin acceso de soporte de plataforma** (la plataforma no tiene el permiso y `clinicScope` la excluye).

## 6. Mitigaciones de escalamiento

| Vector | Control |
|---|---|
| El administrador se otorga un rol (`POST /assignments` a sí mismo) | **Bloqueado** (`403`, `ESCALATION_BLOCKED self_grant`) |
| El administrador se invita a sí mismo (o con alias: `+etiqueta`, puntos y `googlemail` en Gmail) | **Bloqueado** a la creación (`self_invitation`) y la cuenta del invitador no puede aceptar su invitación |
| Invita una "segunda identidad" con otro correo | Se permite incorporar personal (es una necesidad real), pero queda `granted_by_id` y **no puede asignarle pacientes**; solo otra persona (recepción, Director, otro administrador) |
| Confiere un rol con permisos que no posee | `clinical:read/write/read_limited` quedan **fuera de la regla anti-escalada** (no dan acceso por sí solos); `clinical:read_all` **nunca**: solo el rol Director, por invitación formal |
| Asignarse `CLINICAL_DIRECTOR` | Imposible por asignación; la invitación formal exige registro de aprovisionamiento + reautenticación y no admite autoinvitación |
| Quitar o deshabilitar al Director | **Solo otro Director vigente** de esa clínica (no la administración ni la plataforma), más la regla de último Director |
| Revisión | `GET /v1/care-relationships` muestra, por odontólogo, `dentistRoleGrantedById` y quién creó la relación |

### 6.1 Reemplazo del Director Clínico (flujo formal documentado)
1. **Normal:** el Director vigente invita al sucesor (`director:manage`, con reautenticación). Cuando acepta hay dos Directores.
2. Cualquiera de los dos puede deshabilitar o retirar el rol del otro (con motivo). **El último Director no puede ser retirado ni deshabilitado por nadie** (ni él mismo, ni la administración, ni la plataforma).
3. **Vacancia (el único Director ya no está disponible):** el sistema **no** tiene un flujo automático. Procedimiento operativo propuesto **[por validar]**: la clínica documenta la vacancia (acta del representante legal), la plataforma verifica por un canal independiente y se interviene la base de datos de forma controlada, con registro externo y auditoría, para reabrir el aprovisionamiento formal del primer Director. Hasta decidir ese flujo es un **riesgo residual conocido**.

## 7. Auditoría

`CLINICAL_RECORD_VIEWED` · `CLINICAL_READ_ALL_GRANTED` · `CLINICAL_READ_ALL_READ` · `CLINICAL_WRITE_AUTHORIZED` · `CLINICAL_ACCESS_DENIED` (usuario, clínica, sede, paciente **solo si es de su clínica**, motivo, roles) · `CARE_RELATIONSHIP_CREATED/REVOKED/ENDED/…LISTED` · `CLINICAL_ROLE_GRANTED` · `ESCALATION_BLOCKED` · `DIRECTOR_PROTECTION_BLOCKED`. Nunca se copia contenido clínico, tokens ni la prueba de reautenticación. Las negativas por falta de permiso `clinical:*` siguen en `ACCESS_DENIED` (patrón de ruta, sin ids).

## 8. Endpoints

| Ruta | Permiso | Nota |
|---|---|---|
| `GET /v1/patients/:id/clinical-summary` | cualquier `clinical:read`, `read_limited` o `read_all` | La decisión real la toma `ClinicalAccessService` |
| `POST /v1/patients/:id/clinical-access` | `clinical:read_all` | 201; autorización de 30 min |
| `POST /v1/patients/:id/care-relationships` · `GET` | `care:assign` | Alta (solo origen asignación) y listado del paciente |
| `GET /v1/care-relationships` | `care:assign` | Revisión de la clínica (filtros `status`, `dentistUserId`) |
| `POST /v1/care-relationships/:relId/revoke` | `care:assign` | Motivo obligatorio; `409` si ya no está vigente |
| `POST /v1/users/:id/disable` · `/reactivate` · `PATCH /v1/assignments/:id/revoke` | `user:manage`/`assignment:manage`, o `director:manage` si el destino es Director | Protección del Director |

## 9. Modelo de datos
Migración `20261015000000_care_relationships_and_clinical_access`: `patient_care_relationships`, `clinical_access_grants`, `user_assignments.granted_by_id` y los triggers descritos.

## 10. Riesgos residuales y limitaciones

1. **Colusión de dos personas** (el administrador que invita + recepción que asigna): logran acceso a un paciente. Todo queda trazado y es visible en `GET /v1/care-relationships`, pero no se impide. Mitigación futura: informe periódico al Director y confirmación del Director para relaciones nuevas de odontólogos incorporados por un administrador.
2. **Alias en dominio propio** (`yo@mi-dominio.pe` e `ysegundo@mi-dominio.pe`) no se detecta por correo; solo lo frena la separación de funciones.
3. **Clínicas de una sola persona/dos personas**: la separación de funciones exige al menos dos actores (quien otorga y quien asigna). Es un efecto buscado.
4. **Vacancia del único Director**: sin flujo automático (6.1).
5. **Datos demográficos**: el odontólogo, el asistente y el Director ven la ficha demográfica de todos los pacientes de la clínica (pregunta abierta 12). 3.1 solo restringe lo **clínico**.
6. **Relaciones por cita/visita**: la tabla y el cierre por vigencia están listos, pero no hay agenda ni visitas que las generen; hoy solo por asignación manual.
7. **El motivo de `clinical:read_all` es texto libre** que se guarda en la auditoría: depende de que el Director no incluya datos clínicos.
8. **Sin informe de usos** de `clinical:read_all` ni alertas automáticas (3.5).
9. **Sesión larga**: una autorización dura 30 min aunque la sesión viva más; no se prolonga.
10. El asistente ve pacientes con relación vigente **de cualquier odontólogo** en su sede (no una relación propia). Definición **[por validar con Clínica Demo]**.

## 11. Verificación (MySQL Community 8.4.6, base creada desde cero)
Ver la sección final del reporte del sub-incremento y la suite: `care-relationships` (25), `clinical-access` (28), `clinical-escalation` (9), más los ajustes a `last-authority`, `user-status`, `director`, `mysql-engine`, `maintenance` y pacientes.

## 12. Condiciones OBLIGATORIAS antes de cargar pacientes reales
1. **Canal de entrega de invitaciones y recuperación probado** de extremo a extremo (webhook firmado, receptor verificando firma y antigüedad, entrega real al correo).
2. **Respaldo diario externo con restauración verificada** (base de datos y directorio de adjuntos), con una prueba de restauración documentada.
3. **Revisión legal** de los puntos normativos de la política (datos de salud, historia clínica, figura del Director, conservación) y de los plazos de retención.
Además: notificación de "contraseña cambiada", mantenimiento programado y revisión periódica de la auditoría clínica.

## 13. Para iniciar 3.2 (antecedentes, alergias y alertas)
1. Cada lectura/escritura nueva debe llamar a `ClinicalAccessService.authorize` **y** auditar **antes** de entregar (falla cerrada); nunca consultar tablas clínicas fuera de ese camino.
2. Las alertas clínicas reales se suman a las derivadas del consentimiento en `alerts`; la vista del asistente crece solo con lo aprobado.
3. Las escrituras se auditan en la misma transacción y usan `authorize(..., 'write')`.
4. Decidir el cifrado a nivel de campo y la exportación antes de guardar texto clínico.
