# Parche 3.2.1: evaluación de alergias y motivo del alta

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15). Parche pequeño sobre [`incremento-3-2-antecedentes-alertas.md`](incremento-3-2-antecedentes-alertas.md). Migración `20261017000000_allergy_assessment_and_optional_initial_reason`.

## 1. Evaluación de alergias (estado explícito y versionado por paciente)

Distingue **"no se preguntó"** de **"se preguntó y no reporta alergias conocidas"**:

| Estado | Significado | Quién lo fija |
|---|---|---|
| `NOT_ASKED` | Aún no se evaluó | Valor inicial (sin filas = versión 0); el profesional; o el sistema al quedar sin alergias activas |
| `NO_KNOWN_ALLERGIES` | Se consultó y el paciente no reporta alergias conocidas | El profesional |
| `ALLERGIES_RECORDED` | Existe al menos una alergia activa registrada | **Solo el sistema** (no se declara) |

**Invariante** (aplicación **y** triggers de la base de datos): `ALLERGIES_RECORDED` ⇔ hay al menos una alergia activa vigente. Por eso `NO_KNOWN_ALLERGIES` (y `NOT_ASKED`) se rechazan con `409 ALLERGIES_ACTIVE` si hay una alergia activa.

Cómo se mantiene:
- Al **registrar, reactivar** o cambiar una alergia que deja al paciente con alergias activas, el sistema agrega una versión **automática** `ALLERGIES_RECORDED` en la misma transacción.
- Al **desactivar o marcar por error** la última alergia activa, vuelve a `NOT_ASKED` (la evaluación debe repetirse). Si queda otra activa, no cambia nada.
- Un antecedente (`BACKGROUND`) no afecta la evaluación.
- Pacientes con alergias previas a la tabla (sin filas) se muestran como `ALLERGIES_RECORDED` **derivado** (`derived: true`).

Cada versión guarda **fecha de la consulta** (`assessedOn`, no futura), **fuente** (obligatoria), **autor**, **observación** opcional (≤ 500), `automatic` (la generó el sistema) y el motivo. El alta no exige motivo; **desde la versión 2 el motivo es obligatorio** (también en las automáticas, con un texto fijo). Historial inmutable: sin `DELETE`, sin reescritura, una sola vigente.

Endpoints (permiso de ruta: cualquier `clinical:*` de lectura / `clinical:write`; la decisión real la toma el motor de 3.1):
- `GET /v1/patients/:id/clinical/allergy-assessment` y `…/versions` — odontólogo con relación o Director con autorización. **El asistente no** (`403 CLINICAL_LIMITED_VIEW`).
- `PUT /v1/patients/:id/clinical/allergy-assessment` `{ status, source, expectedVersion, assessedOn?, observations?, reason? }` — solo odontólogo con relación (sede de origen). `expectedVersion` es la versión leída (0 si no hay). `409 VERSION_CONFLICT` si cambió.
- `GET …/clinical-summary` incluye `allergyAssessment` en el nivel completo (no en la vista del asistente).

**Concurrencia:** las altas/cambios de alergias y la declaración de la evaluación comparten el bloqueo de la fila del paciente; así no pueden coexistir `NO_KNOWN_ALLERGIES` y una alergia activa, aunque ocurran a la vez (probado en 8 rondas). Dos declaraciones sobre la misma versión: una prospera. La revocación de la relación sigue funcionando como en 3.2 (revalidación bajo `FOR SHARE`).

**Auditoría:** `CLINICAL_ALLERGY_ASSESSMENT_SET` y `…_AUTO_UPDATED` (en la transacción) guardan **versión, tipo de cambio, `automatic` y nombres de campos**. **No** guardan el estado (que ya es clínico) ni las observaciones. La lectura se audita como las demás (`allergy_assessment`).

## 2. Motivo: ajuste de la decisión de 3.2

| Operación | Motivo |
|---|---|
| **Alta inicial** de antecedente, alergia o alerta | **Opcional** (si se informa, ≥ 3 caracteres). La **fuente/origen sí es obligatoria** |
| Corrección, rectificación, desactivación, reactivación, "ingresado por error" | **Obligatorio** (≥ 3) |
| Alta inicial de la evaluación de alergias | Opcional; desde la versión 2, obligatorio |

La base de datos lo impone: `change_reason` pasó a ser nulo-permitido y los triggers exigen motivo desde la versión 2 (y que, si se informa en el alta, sea significativo). El versionado y la trazabilidad completa se mantienen (autor, fecha, tipo de cambio, campos modificados).

## 3. Vista del asistente (sin cambios)
Sigue viendo **solo alertas activas** con **etiqueta breve** (la alergia o antecedente crítico, o el texto de la alerta manual), severidad, origen y vigencia — necesario para apoyo seguro durante la atención. **No** ve antecedentes, alergias no críticas, observaciones, condición, motivos, versiones, la evaluación de alergias ni historial; todo eso responde `403 CLINICAL_LIMITED_VIEW` y se audita. Sigue **[por validar con Clínica Demo]**.

## 4. Pruebas (parche)
`allergy-assessment.e2e-spec.ts` (22): estados, restricciones (fuente, fechas, `ALLERGIES_RECORDED` no declarable, `NO_KNOWN` con alergia activa), transiciones automáticas, derivado para datos previos, invariante y triggers en la base, motivo del alta opcional / cambios con motivo, vista del asistente, aislamiento entre clínicas, relación revocada o de otra sede, Director con y sin autorización, falla de auditoría, y concurrencia (declarar vs. registrar alergia, declaraciones simultáneas, altas y bajas simultáneas, revocación del acceso). Ajustes a las pruebas de 3.2 por el motivo opcional.

## 5. Riesgos que quedan
- La evaluación **no valida clínicamente** nada: refleja lo que el profesional declara. `NO_KNOWN_ALLERGIES` no caduca; no hay recordatorio para repetirla.
- Al quedar sin alergias activas el sistema vuelve a `NOT_ASKED`; es una decisión conservadora **[por validar con Clínica Demo]** (otra opción sería conservar un estado "alergias retiradas").
- El texto de las observaciones es libre y clínico: visible solo con acceso autorizado, nunca en auditoría.
- Los puntos normativos de 3.2 (sección 8) siguen **[por validar]**.

## 6. Política decidida para 3.3 (consentimiento clínico)
**El consentimiento clínico faltante NO bloquea el diagnóstico ni el registro de una visita**; **sí debe bloquear el cierre de los procedimientos que la clínica haya configurado como "requiere consentimiento"**. Así la operación sigue siendo viable y la decisión clínica queda bajo responsabilidad profesional. Implicaciones para 3.3:
- La configuración "requiere consentimiento" es **por clínica** (y por tipo de procedimiento); por defecto no bloquea nada.
- El bloqueo se aplica **al cerrar** el procedimiento (no al abrirlo ni al planificarlo), usando `clinicalConsentStatus` (estado `GRANTED`).
- Diagnóstico y visita siguen mostrando la alerta de consentimiento faltante, sin bloquear.
- Debe quedar auditado el intento bloqueado (sin contenido clínico) y la causa visible para el profesional.
- Define aún **[por validar]**: si un profesional puede cerrar con una excepción justificada (y bajo qué rol), y qué consentimiento específico aplica a qué procedimiento.
