# Incremento 4.1: simuladores de Apiworking para demostración

**Estado:** implementado y validado contra MySQL 8.4 (2026-10-15). **Listo para una demostración funcional, NO para producción.** No hay integración real: ni credenciales, ni endpoints, ni emisión ante SUNAT. Los contratos reales de Apiworking y SUNAT están **[por validar]**; nada de este incremento afirma cumplimiento tributario.

Flujo que permite mostrar: **paciente → cita → atención → odontograma → cobro → comprobante simulado → fidelización simulada** (y solicitud de reseña simulada).

## 1. Activación y límites
- `INTEGRATIONS_MODE=off` (por defecto) o `mock`. **No existe modo «real»**: cualquier otro valor impide arrancar. Con `off`, las rutas de cobros, comprobantes, fidelización y reseñas responden `503 INTEGRATIONS_DISABLED` y el panel no muestra esos módulos ni el aviso.
- Con `NODE_ENV=production`, `mock` exige además `INTEGRATIONS_MOCK_ALLOW_PRODUCTION=true` (solo demostraciones en un servidor; decisión a confirmar). `INTEGRATIONS_WORKER_INTERVAL_MS` (0 = solo bajo demanda) activa el procesador periódico de la cola.
- Nada de este módulo contiene datos clínicos: los cobros enlazan a la **cita** (nunca a la visita), el concepto es el nombre del servicio y el comprobante solo lleva nombre y documento del cliente.

## 2. Adaptadores (puertos y simuladores)
Interfaces en `src/integrations/providers/`: `BillingProvider` (`emit`, `getStatus` por clave de idempotencia), `LoyaltyProvider` (`accrue`, `redeem`, `summary`, `nfcSummary`) y `ReviewProvider` (`requestReview`, `summary`). Los servicios dependen **solo** de esas interfaces; `IntegrationsModule` las resuelve por fábrica (`MockBillingProvider`, `MockLoyaltyProvider`, `MockReviewProvider`, o un proveedor «deshabilitado» que falla explícitamente). Un adaptador real las implementaría y reemplazaría a los simuladores en esas fábricas sin tocar servicios, controladores ni panel. Los simuladores guardan su «memoria» en tablas `mock_*` (clave de idempotencia → respuesta), de modo que se comportan como un proveedor real ante reenvíos.

**Escenarios de comprobante** (se eligen en la interfaz, solo en demostración): *emitido de inmediato*, *queda pendiente de confirmación*, *rechazado*, *falla una vez y luego se emite* (reintento) y *no responde a tiempo* (el proveedor lo procesó pero la respuesta no llegó: requiere conciliación). Los textos de rechazo son ficticios; no se inventan códigos de SUNAT.

## 3. Cobros, comprobantes, cola y conciliación (como si fuera real)
| Pieza | Comportamiento |
|---|---|
| **Cobro** (`charges`) | Desde una cita **atendida** (monto sugerido = precio del servicio) o manual. Monto inmutable (también por trigger). Pagar (efectivo, tarjeta, Yape/Plin, transferencia) usa versión optimista; doble pago simultáneo → uno solo gana. Anular solo si está pendiente y sin comprobante. Un cobro vigente por cita |
| **Comprobante** (`billing_documents`) | Boleta (`BD01-########`) o factura (`FD01-…`, RUC y razón social ficticios). Correlativo por serie con bloqueo. IGV 18 % incluido. Un comprobante vigente por cobro (restricción única); uno **rechazado es definitivo** y se emite otro nuevo (otro número y otra clave). Emitido/rechazado son inmutables (trigger); no se eliminan |
| **Marca** | Todo comprobante lleva **«DEMO — NO VÁLIDO PARA SUNAT»**: columna `demo_mark` con `CHECK` exacto (la base de datos rechaza otro texto), visible en la API, en la ficha, en la lista y en el PDF (cabecera, marca de agua diagonal y pie) |
| **Estados locales** | Pendiente de envío · Enviado · Emitido · Rechazado · Error reintentable · Requiere conciliación |
| **Idempotencia** | Clave `doc:<cobro>:<n>` hacia el proveedor: reenviar nunca duplica. Doble clic → `409 DOCUMENT_EXISTS`. Acumular puntos o pedir reseñas dos veces tampoco duplica |
| **Cola (outbox)** | El cambio local y el mensaje se guardan en la misma transacción (`integration_outbox`: emisión, puntos, reseña). Un procesador reclama con arrendamiento de 60 s, reintenta con espera creciente (30 s … 10 min), `FALLÓ` tras 5 intentos; «Procesar cola» lo ejecuta bajo demanda. La emisión se intenta de inmediato y, si falla, queda en cola |
| **Reintento** | Solo de «error reintentable», con la misma clave |
| **Conciliación** | Consulta al proveedor por la clave: si lo emitió/rechazó, alinea el estado; si nunca lo recibió, lo reencola (seguro por idempotencia). Individual o masiva |
| **Auditoría** | `CHARGE_CREATED/PAID/VOIDED`, `DOCUMENT_QUEUED/ISSUED/SENT/REJECTED/RETRYABLE_ERROR/NEEDS_RECONCILIATION/RECONCILED/RETRY_REQUESTED/PDF_DOWNLOADED`, `OUTBOX_PROCESSED`, `LOYALTY_ACCRUED/REDEEMED`, `REVIEW_REQUESTED` (todas con `simulated: true`) |

Permisos nuevos: `charge:read|manage`, `billing:read|manage`, `loyalty:read|manage` (el administrador de plataforma no los tiene). Cajero: todos; recepción: cobros (leer y gestionar), comprobantes y fidelización (solo leer); administrador de clínica: todos (el administrador debe poder otorgar el rol de Cajero: regla anti-escalada); odontólogo, asistente y Director: ninguno. Aislamiento por clínica y sede (404 uniforme).

## 4. Fidelización y reseñas simuladas
Regla ficticia: **1 punto por cada S/ 10 pagados**. Los puntos y las solicitudes de reseña solo se generan si el paciente **autorizó** (consentimiento `LOYALTY` vigente para puntos; `MARKETING` para reseñas); sin autorización el mensaje queda **omitido** con la nota y la interfaz solo muestra el aviso. Saldo, acumulado, canjeado, nivel (bronce/plata/oro, simulados), últimos movimientos, **canje** idempotente (`requestId`; sin puntos suficientes → `409`) y **resumen NFC** ficticio y determinista (tarjeta «NFC DEMO», estado, visitas en 30 días, último uso). Reseñas: promedio, total y comentarios **ficticios**; solo el contador de solicitudes enviadas es real (local). Todas las respuestas incluyen `simulation` con la etiqueta fija.

## 5. Panel
Banner permanente (**«DEMO — NO VÁLIDO PARA SUNAT. SIMULACIÓN: datos ficticios…»**) y etiqueta «Simulación» en cada bloque simulado. Pantallas: **Caja** (lista de cobros), **detalle del cobro** (pago, anulación con motivo, emisión de comprobante con tipo y escenario, tarjeta del comprobante con marca, reintentar, conciliar, PDF), **Comprobantes** (lista, cola, «Procesar cola», «Conciliar pendientes»), **fidelización** en la ficha del paciente (saldo, canje, NFC) y **reseñas** en «Hoy». «Registrar cobro» aparece en la cita atendida. Con las integraciones apagadas nada de esto aparece.

## 6. Demostración
`INTEGRATIONS_MODE=mock` en `.env`, `npm run db:seed` y los dos servidores. Recepción demo (`recepcion.demo@apidental.test`) agenda y cobra; la odontóloga demo atiende la cita de hoy de «Camila Demo Nueva» (con autorización de fidelización y comunicaciones); para emitir comprobantes use una cuenta con rol Cajero (o el administrador de la clínica). Recorrido: cita → *Iniciar atención* → odontograma → *Registrar cobro* → *Registrar pago* → *Emitir comprobante simulado* (probar «rechazado», «falla una vez» y «no responde a tiempo») → *Comprobantes → Procesar cola* → ficha del paciente: puntos y NFC simulados.

## 7. Riesgos y pendientes antes de cualquier integración real
- Contratos y autenticación reales de Apiworking, tipos y series reales, reglas tributarias (IGV, exoneraciones, anulaciones, notas de crédito), códigos de rechazo y su mapeo: **[por validar]**. No existen anulación de comprobantes, notas de crédito, pagos parciales, caja diaria ni cierres.
- La numeración y las series son de demostración (`BD01`/`FD01`); un proveedor real decidirá las suyas.
- Datos personales: en producción real el comprobante y la fidelización envían datos del paciente a un tercero; requieren base legal, contrato y revisión legal (consentimientos ya separados). No se enviarán datos clínicos.
- La cola se ejecuta en el mismo proceso de la API; para producción conviene un procesador dedicado, métricas y alertas de mensajes `FALLÓ`.
- Siguen vigentes las condiciones previas a datos reales (canal de entrega probado, respaldo externo verificado, cifrado y secretos, revisión legal).
