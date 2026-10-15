# Ficha de atención: contrato de pantalla (sin implementar el frontend)

Pantalla de **una sola ficha de visita** para el panel React (`apps/admin`, bajo `/admin`). Este documento fija el flujo, los campos, los textos y los datos demo que la pantalla necesitará. Se apoya en el [sistema de diseño](sistema-de-diseno.md) y en [3.4](../arquitectura/incremento-3-4-evoluciones.md).

> **Principio:** el odontólogo atiende, no administra el sistema. Pocas decisiones, pocos campos obligatorios, ningún nombre técnico, ningún modal salvo uno (confirmar identidad al cerrar).

## 1. Quién ve qué (cada uno ve su ficha)

| Perfil | Qué ve | Qué puede hacer |
|---|---|---|
| **Odontólogo responsable** | La ficha completa | Escribir diagnóstico, procedimientos y evolución; cerrar; corregir |
| Otro odontólogo con relación | Ficha completa en **solo lectura** (el borrador se ve como "Borrador en curso", sin texto) | Nada |
| **Asistente** | **Solo las alertas** del paciente (no recibe la ficha: `403`) | Preparar el consultorio con las alertas |
| **Recepción / caja / administración** | **Nada clínico**; ven la ficha del paciente (datos administrativos) y, en su caso, "Falta el consentimiento clínico" como aviso | Registrar el consentimiento (recepción) |
| **Director Clínico** | Solo lectura **excepcional**: pide motivo + contraseña para ese paciente (30 min) | Leer; nunca escribir |

Los permisos los resuelve el servidor: la pantalla solo usa `actions` y `access` de la respuesta.

## 2. Distribución (una pantalla, de arriba abajo)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Lucía Demo Adulta · 37 años         Visita 1 · Abierta · Sede Demo         │
├────────────────────────────────────────────────────────────────────────────┤
│ ⚠ ALERTAS                                                                  │
│   Importante · Alergia · Alergia a un material ficticio (demostración)     │
│   Información · Aviso · Aviso de demostración (dato ficticio)              │
│   Tiene alergias registradas        Consentimiento clínico vigente         │
├────────────────────────────────────────────────────────────────────────────┤
│ DIAGNÓSTICO                                                [+ Agregar]     │
│   Diagnóstico de demostración (dato ficticio) · Definitivo                 │
├────────────────────────────────────────────────────────────────────────────┤
│ PROCEDIMIENTOS                                             [+ Agregar]     │
│   Restauración dental (demo) · En curso   [Marcar como realizado]          │
│   ⓘ Para cerrar este procedimiento falta el consentimiento clínico         │
├────────────────────────────────────────────────────────────────────────────┤
│ EVOLUCIÓN                                          Borrador · se guarda solo│
│   [ texto…………………………………………………………………… ]                              │
│   Indicaciones y seguimiento (opcional)                                    │
│                              [Descartar]            [Cerrar evolución]     │
├────────────────────────────────────────────────────────────────────────────┤
│                                           [Cerrar visita]                  │
└────────────────────────────────────────────────────────────────────────────┘
```
**Orden de lectura fijo:** alertas → diagnóstico → procedimientos → evolución. Las alertas siempre arriba y visibles sin desplazarse.

## 3. Una lectura, una llamada
`GET /v1/patients/:patientId/clinical/visits/:visitId/sheet` devuelve todo lo anterior. Campos que usa la pantalla:

| Bloque | Campos |
|---|---|
| `alerts.items[]` | `id`, `origin` (Alergia / Antecedente / Aviso), `severity`, `label`, `validUntil` |
| `patient` | `fullName`, `age`, `isMinor` |
| `allergyAssessment` | `status`, `label` ("Tiene alergias registradas", "Sin alergias conocidas", "Aún no se preguntó por alergias") |
| `consent` | `state`, `label`, `alerts[]` |
| `visit` | `id`, `number`, `status`, `statusLabel`, `reason`, `startedAt`, `closedAt`, `version` |
| `diagnoses[]` | `id`, `version`, `description`, `certainty` + `certaintyLabel`, `statusLabel` |
| `procedures[]` | `id`, `version`, `name`, `statusLabel`, `requiresConsent`, `closeBlockedByConsent`, `closeBlockedMessage`, `canClose` |
| `evolution` | `id`, `etag`, `state`, `stateLabel`, `body`, `followUp`, `contentHidden`, `closure{closedAt, isSignature:false, notice}`, `lastChange{kind, reason, at}` |
| `actions` | `readOnly`, `canAddDiagnosis`, `canAddProcedure`, `canWriteEvolution`, `canCloseEvolution`, `canCorrectEvolution`, `canCloseVisit`, `closeVisitBlockedBy[]` |
| `labels` | Diccionario de textos para estados y etiquetas |
| `notice` | Texto de que son declaraciones del profesional |

## 4. Estados visibles
- **Evolución:** *Borrador* · *Cerrada* · *Corregida* (más *Descartada* y *Registrada por error* en el historial).
- **Visita:** *Abierta* · *Cerrada* · *Cancelada*. **Procedimiento:** *En curso* · *Realizado* · *Cancelado* · *Registrado por error*. **Diagnóstico:** *Presuntivo* / *Definitivo*; *Vigente* · *Ya no aplica*.
- Mostrar siempre `stateLabel`/`statusLabel`; nunca `DRAFT`, `CLOSED` ni códigos internos.

## 5. Acciones y llamadas (mínimo de pasos)

| Acción en pantalla | Llamada | Notas de UX |
|---|---|---|
| Abrir la visita | `POST …/clinical/visits` `{ reason? }` | Un clic; el motivo es opcional. Si falta el consentimiento, **solo avisa** |
| Agregar diagnóstico | `POST …/visits/:v/diagnoses` `{ description, certainty }` | 2 campos; sin motivo en el alta |
| Agregar procedimiento | `POST …/visits/:v/procedures` `{ definitionId, notes? }` | Elegir del catálogo de la clínica; 1 campo obligatorio |
| Marcar como realizado | `POST …/procedures/:p/close` `{ expectedVersion }` | Si requiere consentimiento y falta: `409 CLINICAL_CONSENT_REQUIRED`; mostrar el mensaje, no un error técnico |
| **Escribir la evolución** | `PUT …/visits/:v/evolution` `{ body, followUp?, expectedEtag? }` | **Guarda solo** al dejar de escribir unos segundos; sin botón "Guardar"; mostrar "Guardado" |
| **Cerrar evolución** | `POST …/evolution/close` `{ expectedEtag, password }` | **Único modal:** "Confirme con su contraseña". Mostrar: *Esto confirma que usted realiza esta acción. No es una firma digital, legal ni clínica.* |
| Corregir una cerrada | `POST …/evolution/correct\|rectify` `{ expectedEtag, reason, body?, followUp?, password }` | Pedir el motivo y la contraseña en el mismo cuadro. *Corregir* = arreglar un error; *Rectificar* = aclarar o actualizar |
| Descartar el borrador | `POST …/evolution/discard` `{ expectedEtag, reason }` | Motivo corto |
| Cerrar la visita | `POST …/visits/:v/close` `{ expectedVersion }` | Si hay procedimientos en curso o un borrador: mostrar qué falta (`closeVisitBlockedBy`) y llevar a ello |

**Conflictos** (`409 VERSION_CONFLICT`): "Alguien modificó esto mientras trabajaba. Vuelva a cargarlo." y recargar la ficha (no perder el texto que el usuario escribió: ofrecer copiarlo).

## 6. Campos obligatorios (reducidos)
- Diagnóstico: descripción + certeza. Procedimiento: tipo. Evolución: texto. **Nada más** para dar de alta.
- Motivo obligatorio **solo** al corregir, rectificar, descartar, desactivar o marcar por error.
- Contraseña **solo** al cerrar o corregir la evolución.

## 7. Textos para odontólogos, recepción y asistentes
| Evitar (interno) | Usar |
|---|---|
| `DRAFT`, `CLOSED`, `ENTERED_IN_ERROR` | Borrador, Cerrada, Registrada por error |
| `VERSION_CONFLICT`, `NOT_A_DRAFT` | "Alguien modificó esto; vuelva a cargarlo" · "Esta evolución ya está cerrada; use Corregir" |
| `CLINICAL_CONSENT_REQUIRED` | "Para cerrar este procedimiento falta el consentimiento clínico del paciente" |
| `NO_CARE_RELATIONSHIP` | "No tiene asignado a este paciente. Pida a recepción que se lo asigne" |
| `CLINICAL_JUSTIFICATION_REQUIRED` | "Para ver este caso indique el motivo y confirme con su contraseña" |
| `CLINICAL_LIMITED_VIEW` | (el asistente no ve la ficha: solo la lista de alertas) |
| `REAUTHENTICATION_REQUIRED` | "No pudimos confirmar su identidad. Inténtelo de nuevo" |

## 8. Accesibilidad y diseño
Contrastes AA del sistema de diseño; estados con **texto + icono** (no solo color); foco visible y orden de tabulación = orden de lectura; el modal de contraseña atrapa el foco y se cierra con Esc; mensajes de error junto al campo; la ficha utilizable con teclado; no usar rojo como único indicador de "Importante".

## 9. Datos demo para ver la pantalla desde el primer día
`npm run db:seed` (solo desarrollo; contraseña = `SEED_DEMO_PASSWORD` o, si falta, `SEED_ADMIN_PASSWORD`). **Todo es ficticio.**

| Cuenta (correo reservado `@apidental.test`) | Rol | Contexto al ingresar |
|---|---|---|
| `odontologa.demo@apidental.test` | Odontólogo | Clínica Demo · **Sede Demo** |
| `asistente.demo@apidental.test` | Asistente | Clínica Demo · **Sede Demo** |
| `recepcion.demo@apidental.test` | Recepción | Clínica Demo |
| `director.demo@apidental.test` | Director Clínico | Clínica Demo |
| `admin.dev@apidental.test` | Administrador (+ plataforma) | Clínica Demo |

| Paciente demo | Qué muestra |
|---|---|
| **Lucía Demo Adulta** (DNI 90000001) | Alergia crítica + aviso → visita **Cerrada** → diagnóstico → procedimiento **Realizado** → evolución **Corregida** |
| **Mateo Demo Menor** (DNI 90000002) | Visita **Abierta** con la evolución en **Borrador** |
| **Jorge Demo Repetido** (DNI 90000004) | Visita **Abierta**, evolución **Cerrada** y un procedimiento que **no se puede cerrar** por falta de consentimiento |

Catálogo demo: *Control de rutina (demo)*, *Limpieza dental (demo)*, *Restauración dental (demo)* (esta última "requiere consentimiento"). No hay fotografías, direcciones, teléfonos ni correos reales; ninguna captura o ejemplo debe usar datos que no sean estos.
