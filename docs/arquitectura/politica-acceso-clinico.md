# Política de acceso clínico (P0)

**Estado:** adoptada para P0 por decisión del responsable del producto (2026-10-14). **Implementada en el sub-incremento 3.1** (2026-10-15): ver [`incremento-3-1-acceso-clinico.md`](incremento-3-1-acceso-clinico.md), que describe cómo se aplica y qué decisiones de producto la afinaron (relación por cita/visita/asignación, lectura en otras sedes, vista del asistente, consentimiento como alerta). Su validación normativa/legal queda **[por validar]**.

Alcance: datos **clínicos** (historia clínica, antecedentes, alergias, alertas clínicas, visitas, diagnósticos, procedimientos, evoluciones y, más adelante, odontograma y adjuntos clínicos). Los datos demográficos, de contacto, consentimientos y adjuntos administrativos siguen regidos por el [incremento 2](incremento-2-pacientes.md).

## 1. Principios

1. **Denegar por defecto.** Sin permiso explícito y sin relación asistencial, no hay acceso clínico.
2. **Mínimo privilegio y necesidad de conocer.** Cada rol ve solo lo que necesita para su tarea.
3. **Relación asistencial.** Un odontólogo accede a la historia de un paciente solo si atiende a ese paciente.
4. **Todo acceso queda trazado**, incluidos los denegados, sin copiar contenido clínico a la auditoría.
5. **Las excepciones son explícitas, justificadas, acotadas en el tiempo y auditadas.**
6. **Nadie se otorga a sí mismo acceso clínico.**
7. **La plataforma no ve información clínica.**

## 2. Política por rol

| Rol | Acceso clínico | Detalle |
|---|---|---|
| **Administrador de plataforma** | **Ninguno** | Sin acceso predeterminado ni acceso de soporte (ver 6). |
| **Administrador de clínica** | **Total, auditado** | Decisión del responsable del producto (2026-10-15): vista y acciones sobre todo el sistema. Permiso `clinical:admin` (+ `clinical:view`, `clinical:write`): lee y registra en cualquier paciente de **su** clínica sin relación asistencial (otra clínica: 404). Cada acceso queda auditado (`via: admin_access`). **No** obtiene `clinical:read_all`. Las acciones ligadas a una visita (abrirla, evolución, diagnósticos y procedimientos de la visita) siguen siendo del odontólogo responsable (separación de funciones). |
| **Odontólogo** | **Lectura y escritura** | Solo de pacientes con **relación asistencial** y dentro de **sus sedes asignadas**. Es el único que crea, edita y corrige evoluciones, diagnósticos y procedimientos. |
| **Asistente** | **Lectura limitada** | Ve la *vista de apoyo* (ver 3.3) de pacientes con relación vigente en su sede. **No crea, edita ni corrige** evoluciones ni ningún dato clínico. |
| **Recepcionista** | **Solo lectura (vista)** | Decisión del responsable del producto (2026-10-15): ve la información clínica (ficha, historia, evolución, odontograma) sin necesitar relación asistencial, **nunca escribe** y cada lectura queda auditada (`CLINICAL_RECORD_VIEWED`, nivel `VIEW`, sin contenido clínico). Además asigna pacientes a odontólogos (acto administrativo). |
| **Cajero** | **Ninguno** | Solo lo necesario para cobrar. |
| **Director Clínico** | **Lectura excepcional** con `clinical:read_all` | Solo lectura de cualquier paciente de su clínica, con justificación y auditoría reforzada (ver 4). No escribe. |

Notas:

- **Administrador de clínica ≠ Director Clínico.** El administrador accede por `clinical:admin` (auditado); la lectura excepcional `clinical:read_all` sigue exigiendo el rol Director Clínico (ver 4.3).
- Un mismo usuario puede tener varios roles; los permisos se evalúan **por contexto** (clínica y sede activas), como en el RBAC vigente.
- Esta política **no cambia** el acceso demográfico actual (administración, recepción, odontólogo, asistente y cajero según el incremento 2).

## 3. Relación asistencial y alcance por sede

### 3.1 Definición propuesta (por validar con Clínica Demo)

Existe relación asistencial entre un odontólogo **D** y un paciente **P** cuando hay un registro **vigente** de "equipo tratante" de D con P, creado por alguna de estas vías:

| Origen | Quién lo crea | Notas |
|---|---|---|
| **Asignación** | Recepción, administrador de clínica o Director Clínico ("asignar paciente a odontólogo") | Vía normal en P0, mientras no exista agenda. Queda auditada. |
| **Cita / atención** | Automático cuando D tenga una cita o una visita con P | Cuando exista el módulo de agenda. |
| **Derivación / interconsulta** | Otro odontólogo con relación vigente | Con vigencia y motivo. |
| **Autoasignación con motivo** | El propio odontólogo, al abrir una visita para un paciente sin relación (p. ej. urgencia, primera vez) | Permitida, pero **marcada para revisión** y visible en el informe del Director Clínico. Es la salida a la urgencia sin crear un "acceso de emergencia" aparte. |

La relación tiene `desde`, `hasta` (opcional) y `motivo/origen`; puede cerrarse. **Vigencia por inactividad: [por validar]** (propuesta inicial: sin visitas ni asignación en 12 meses se considera inactiva).

### 3.2 Alcance por sede

- La historia pertenece al **paciente y a la clínica**, y se comparte entre sedes (requisito de producto).
- El odontólogo **opera** (crea visitas, evoluciones, diagnósticos, procedimientos) solo en **sedes donde tiene asignación activa**; una asignación de toda la clínica cubre todas las sedes.
- La relación se evalúa **en el contexto activo**: el odontólogo debe haber elegido una sede que pertenezca a sus asignaciones.
- Una vez establecida la relación, el odontólogo ve el **historial completo** del paciente, incluidas entradas hechas en otras sedes de la clínica (continuidad asistencial). **[Pregunta abierta: ¿se restringe a lo creado en sus sedes?]**

### 3.3 "Vista de apoyo" del asistente (lectura clínica limitada)

> **Implementada en 3.2 con un alcance menor al propuesto abajo:** el asistente ve solo **alertas activas y mínimas** (origen, severidad, etiqueta breve, vigencia). No ve antecedentes ni alergias no críticas, ni detalle, ni versiones. Ver [`incremento-3-2-antecedentes-alertas.md`](incremento-3-2-antecedentes-alertas.md).

Propuesta, **[por validar con Clínica Demo]**:

| Puede ver | No puede ver |
|---|---|
| Alertas clínicas y alergias | Texto de las evoluciones |
| Antecedentes (resumen de solo lectura) | Diagnósticos con su detalle libre |
| Procedimientos de la visita en curso y de la agenda del día | Historial de visitas anteriores |
| Datos para preparar el consultorio (pieza, procedimiento indicado) | Cualquier dato fuera de las visitas con relación en su sede |

Nunca puede crear, editar, corregir, cerrar ni marcar "ingresado por error".

## 4. Permiso excepcional `clinical:read_all`

### 4.1 Qué es

Permite **leer** (nunca escribir) información clínica de cualquier paciente **de su clínica**, sin relación asistencial. Es un permiso de **gobierno clínico** (auditoría de calidad, continuidad, reclamos o requerimientos), no de atención.

### 4.2 Quién lo tiene

- **Inicialmente solo** el rol **Director Clínico** (rol nuevo, por crear) o un **administrador clínico expresamente autorizado**.
- **Ningún otro rol** lo recibe, ni por herencia: ni administrador de plataforma, ni administrador de clínica, ni odontólogo, asistente, recepción o caja.
- No existe como permiso asignable suelto: se otorga únicamente mediante el rol Director Clínico.

### 4.3 Cómo se otorga (mecanismo propuesto)

1. **Primer Director Clínico:** se designa en el **aprovisionamiento formal de la clínica** (ver 7), con una **referencia a la autorización expresa** del representante de la clínica (documento o acta) guardada en la auditoría.
2. **Cambios posteriores:** solo un Director Clínico vigente puede otorgar o revocar el rol (la regla anti-escalada ya vigente lo impone de forma natural: nadie otorga un permiso que no posee). Siempre con **motivo y referencia de autorización**.
3. **Administrador clínico expresamente autorizado:** es un administrador de clínica **al que se le asigna, además, el rol Director Clínico** por el paso 1 o 2. No se acumula por defecto.
4. **Nadie puede otorgárselo a sí mismo**, ni el administrador de plataforma ni el de clínica.
5. Cada otorgamiento y revocación se audita y se notifica a los demás Directores Clínicos de la clínica (por validar el canal).

### 4.4 Cómo se usa: cada acceso con justificación

Cada vez que se usa `clinical:read_all` sobre un paciente:

1. El usuario declara **categoría y motivo** (texto de al menos 10 caracteres) para **ese paciente**. Categorías propuestas: continuidad asistencial · auditoría de calidad · reclamo o requerimiento legal · otro (con detalle).
2. El sistema abre una **autorización de lectura de vigencia corta** (propuesta: 30 minutos, solo ese paciente).
3. **Antes de devolver cualquier dato**, se registra en la auditoría: **usuario, paciente, fecha y hora, IP, user agent, categoría, motivo** y las secciones consultadas. Si no se puede registrar, **no se entrega el dato** (falla cerrada).
4. Cada lectura posterior dentro de esa autorización **también** se registra, con referencia a ella.
5. Sin motivo válido, sin autorización vigente o fuera de su clínica: **denegado y auditado**.
6. **Informe periódico** de usos de `clinical:read_all` para el Director Clínico y el representante de la clínica (por validar destinatarios y frecuencia).

La auditoría **no copia contenido clínico**: guarda quién, a quién, cuándo, desde dónde, por qué y qué secciones.

## 5. Matriz resumen de permisos clínicos (nombres propuestos)

| Permiso | Odontólogo | Asistente | Director Clínico | Admin clínica | Recepción | Caja | Plataforma |
|---|---|---|---|---|---|---|---|
| `clinical:read` (con relación y sede) | ✔ | — | — | — | — | — | — |
| `clinical:view` (solo lectura visual, sin relación; auditada) | — | — | — | — | ✔ | — | — |
| `clinical:write` (crear, editar borradores, cerrar, corregir) | ✔ | — | — | — | — | — | — |
| `clinical:read_limited` (vista de apoyo, con relación y sede) | — | ✔ | — | — | — | — | — |
| `clinical:read_all` (solo lectura, con justificación) | — | — | ✔ | solo si además es Director | — | — | — |
| `care:assign` (asignar paciente a odontólogo; no clínico) | — | — | ✔ | ✔ | ✔ | — | — |

Nota: `clinical:view` se añadió el 2026-10-15; nunca habilita escritura (toda escritura exige `clinical:write`).

Los nombres se confirman en el incremento 3. `clinical:read_all` **ya existe** (3.1), creado **junto con** su justificación, reautenticación y auditoría previa; solo el rol Director Clínico lo posee (un trigger lo impide en cualquier otro).

## 6. Plataforma y soporte

- **Administrador de plataforma: sin acceso clínico predeterminado** y `clinicScope` ya impide operar datos de pacientes fuera de una clínica.
- **No se implementa acceso de soporte de plataforma a información clínica en esta etapa.** No hay "modo soporte", "suplantar usuario" ni consultas administrativas sobre datos clínicos.
- Consecuencias prácticas: el soporte y la depuración trabajan con **datos ficticios**, *logs* sin contenido clínico y la auditoría (que no contiene datos clínicos). Ninguna herramienta interna debe poder leer tablas clínicas.
- **Riesgo residual conocido:** quien tenga acceso al servidor o a la base de datos (SSH/root, usuario de BD) puede técnicamente leer datos. Mitigaciones previstas, sin sustituir un contrato **[por validar]**: usuario de aplicación distinto del de migraciones, cifrado de disco y respaldos, acceso al VPS limitado y registrado, y cláusulas de confidencialidad con quien opere la infraestructura.
- Si en el futuro se necesitara acceso de soporte, deberá ser **excepcional, solicitado por la clínica, con aprobación del Director Clínico, justificado, de duración limitada y auditado**; requiere una decisión nueva.

## 7. Punto de seguridad vigilado: la excepción del aprovisionamiento (RESUELTO en 3.0)

En el incremento 2 la plataforma podía otorgar roles de clínica directamente (por ejemplo, crear el primer administrador con una contraseña que conocía), una vía indirecta de acceso. **Se retiró en el sub-incremento 3.0** ([`incremento-3-0-acceso-seguro.md`](incremento-3-0-acceso-seguro.md)):

- La plataforma **ya no otorga roles de clínica** ni crea usuarios con contraseña: solo emite una **invitación de un solo uso** al **primer administrador** de una clínica **sin administrador**; la persona define su propia contraseña.
- La plataforma **nunca** designa al Director Clínico ni posee `provisioning:*` ni `director:manage`. El primer Director exige **registro formal de aprovisionamiento** de la clínica + reautenticación; los siguientes, un Director vigente.
- Una clínica no puede quedar sin administrador ni sin Director (regla de último administrador).
- **Riesgo residual documentado:** un operador de plataforma que controle un correo puede invitarlo a una clínica sin administrador. Ese administrador obtiene `clinical:admin` (acceso clínico total, auditado), por lo que el riesgo es mayor que antes; todo queda trazado, pero conviene verificar con la clínica, por un canal independiente, quién es su administrador **[por validar]**. El registro de aprovisionamiento es declarativo mientras no exista firma o flujo contractual integrado.

## 8. Auditoría exigida por esta política

| Evento | Se registra |
|---|---|
| Lectura clínica (odontólogo, asistente) | Usuario, paciente, sede, fecha, IP, user agent, secciones leídas |
| Escritura clínica | Lo anterior + acción, entidad, versión y motivo cuando aplique |
| Uso de `clinical:read_all` | Usuario, paciente, fecha, IP, user agent, **categoría y motivo**, secciones, autorización de origen |
| Acceso clínico **denegado** (sin permiso, sin relación, otra sede, otra clínica) | Usuario, paciente (si existe en su clínica), motivo de denegación |
| Alta, cierre y cambio de relación asistencial | Quién, a quién, origen, vigencia, motivo |
| Otorgar/revocar rol Director Clínico | Quién, a quién, motivo y referencia de autorización |
| Autoasignación con motivo | Marcada para revisión |

Reglas comunes: auditoría **inmutable**, escrita en la misma transacción que la operación cuando es escritura y **antes de entregar el dato** cuando es lectura; **nunca** contenido clínico, contraseñas ni tokens; retención indefinida como decisión comercial actual **[por validar]**.

## 9. Cómo se hará cumplir (resumen técnico, sin código aún)

1. **Permiso del módulo** (guard existente) → 2. **Contexto de clínica** obligatorio (la plataforma queda fuera) → 3. **Paciente de la clínica** (404 uniforme si no) → 4. **Relación asistencial y sede** para odontólogo/asistente → 5. **Auditoría previa a la entrega**.
- **Falla cerrada** en cada paso; los rechazos se auditan.
- **Pruebas e2e negativas** por cada rol y regla (ver incremento 3, sección 8).
- **Triggers de BD** para la inmutabilidad de lo clínico cerrado y la ausencia de borrado físico.
- **Nota sobre `clinical:read_all`:** crear el permiso en el catálogo sin su justificación auditada dejaría una puerta sin cerradura; por eso se crea en el mismo cambio que su control y sus pruebas.

## 10. Preguntas y decisiones por validar

| # | Tema | Quién |
|---|---|---|
| 1 | Base legal y régimen aplicable al acceso a datos de salud (datos sensibles) y a la historia clínica en Perú; qué exige la norma técnica vigente de historia clínica | Asesor legal |
| 2 | ¿Existe en la normativa una figura equivalente al **Director Clínico**? Responsabilidades y quién puede acceder en auditorías internas | Asesor legal / Clínica Demo |
| 3 | Definición exacta de **relación asistencial** y su vigencia (propuesta: 12 meses sin actividad) | Clínica Demo / asesor |
| 4 | Contenido de la **vista de apoyo** del asistente | Clínica Demo |
| 5 | ¿El odontólogo ve entradas hechas en otras sedes de la misma clínica? (propuesta: sí) | Clínica Demo |
| 6 | **Acceso de emergencia** ("romper el cristal") sin relación: no adoptado en P0; hoy se cubre con la autoasignación con motivo y revisión | Producto / Clínica Demo |
| 7 | Categorías y vigencia de la justificación de `clinical:read_all` (propuesta: 30 min por paciente) | Clínica Demo |
| 8 | Destinatarios y frecuencia del informe de usos de `clinical:read_all` | Clínica Demo |
| 9 | Derechos del paciente sobre su historia (acceso, copia, rectificación) y cómo conviven con la inmutabilidad | Asesor legal |
| 10 | Conservación, custodia y entrega de la historia si una clínica termina el servicio (ya prevista exportación) | Asesor legal |
| 11 | Terceros con acceso técnico a la infraestructura (encargado del tratamiento) y sus obligaciones | Asesor legal / Operaciones |
| 12 | ¿Los odontólogos deben ver datos demográficos de todos los pacientes de la clínica (como hoy) o solo de los suyos? | Clínica Demo |
