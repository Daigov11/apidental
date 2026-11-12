# Apiworking real: login, clientes y ventas

Base: `docs/integration/guia-integracion-apiworking.pdf` (aprendido en AGUA SALOMÓN). Convive con los simuladores de
`integrations/` (demostración) y **no comparte tablas con ellos**: las ventas reales viven en `apiworking_sales` y las
cuentas vinculadas en `external_identities`; el comprobante simulado conserva su marca «DEMO».

## Qué hace
1. **Login** (`POST /v1/auth/apiworking-login`): la API llama a `POST /api/User/login` con `{ usuario, password, idSistema }`,
   exige `codResponse = 1`, `data.token`, `data.id_usuario` y que `data.empresa.base_datos` **coincida exactamente** con
   `APIWORKING_AUTHZ_EXPECTED_DATABASE` (una cuenta válida de otro tenant no entra). Crea o enlaza el usuario local **sin
   roles** y emite la sesión local (cookie HttpOnly). El JWT externo queda **solo en memoria del servidor**, atado a la
   sesión local; un reinicio lo borra (hay que volver a entrar). Entrar no da permisos: son siempre locales.
   El login local sigue disponible para el administrador (`/v1/auth/login`; el panel lo ofrece en «Acceso del administrador local»).
2. **Clientes** (`GET /v1/apiworking/clients`): lee `GET /api/Cliente/clientes?bd=<tenant>&displayStart=1&displayLength=1000`
   (solo clientes activos, caché de 60 s, sesión de Apiworking obligatoria). No crea ni modifica clientes.
3. **Ventas** (`/v1/apiworking/sales*`): **venta directa en un clic** («Cobrar»), según el flujo «venta cobrada» de la guía
   (`docs/integration/GUIA_INTEGRACION_APIWORKING.pdf`, 09-11-2026). La caja es la del usuario que inició sesión (`GET /api/Caja`,
   no se elige); se elige el tipo de documento y la forma de pago. El servidor revalida apertura, tipo, serie y forma de pago,
   envía `registro-documento` **una sola vez** (clave de idempotencia; sin vista previa ni aprobación: `approvedHash` es opcional
   y solo se compara si llega) y a continuación aplica el pago con `registrar-pago`. Después: **anular** (con motivo).
   - `data` de las escrituras puede llegar como objeto o como lista de un elemento (`registro-documento` responde
     `data: [{ result, idComprobante, numero… }]`): se aceptan las dos. El número es `<serie>-<numero>`.
   - **Resultado dudoso** (5xx, tiempo agotado, forma inesperada): no se reenvía. El servidor busca solo el comprobante en
     `GET /api/Facturacion` (mismo total y serie, del día, sin otra venta local que lo tenga). Con una coincidencia única lo da por
     registrado (auditado como conciliación automática) y aplica el pago si `controlPagos` no lo muestra. Si no, la venta queda
     «Enviado: número por confirmar» y se vuelve a buscar al listar (como mucho 3 ventas y cada 2 minutos). Verificar y
     conciliar a mano ya no se ofrecen en el panel (los endpoints siguen para soporte).

## Controles (de la guía)
| Control | Cómo |
|---|---|
| Lista cerrada de método y ruta | `ROUTES` en `apiworking.client.ts`; parámetros de consulta exactos por ruta |
| Solo el servidor habla con Apiworking | el navegador nunca ve el JWT externo |
| Interruptores separados, apagados por defecto | `APIWORKING_AUTHZ_READ` / `APIWORKING_AUTHZ_WRITE` (escribir exige leer) |
| Listas cerradas para escribir | cajas, tipos de documento y series autorizados; vacío = nada |
| Tope de envíos reales (opcional) | `APIWORKING_MAX_REAL_OPERATIONS` por 24 h; **0 o ausente = sin tope** (así operan `dental` y `angeldent`) |
| Sin reintentos en escrituras | una sola llamada; un 5xx/tiempo agotado = **resultado desconocido** → `PENDING_RECONCILIATION` |
| Lectura estricta | `codResponse` distinto de 1 es rechazo; campo ausente es error; ids grandes como texto; importes sin `parseFloat` |
| Documento, cobro y anulación separados | `docStatus`, `paymentStatus`, `voidStatus`. **Registrar no aplica el pago**: el cobro solo pasa a «confirmado» si `controlPagos` cubre el total |
| Nada sensible en registros ni auditoría | solo ruta, estado y duración; la auditoría no guarda tokens, contraseñas ni cuerpos |
| Host permitido | `APIWORKING_BASE_URL` solo `*.apiworking.pe` / `*.apiworking.co` (https en producción) |

## Variables de entorno
Ver `.env.example`. Mínimo para el login: `AUTH_MODE=apiworking`, `APIWORKING_SYSTEM_ID`, `APIWORKING_AUTHZ_EXPECTED_DATABASE`.
Para leer: `APIWORKING_AUTHZ_READ=true`. Para escribir además: `APIWORKING_AUTHZ_WRITE=true`. Opcionales: `APIWORKING_MAX_REAL_OPERATIONS` (tope por 24 h),
`APIWORKING_AUTHORIZED_CASH_REGISTERS`, `_DOCUMENT_TYPES`, `_SERIES`, `APIWORKING_WAREHOUSE_ID` y `APIWORKING_UNIT_ID`.
Las rutas reales solo requieren que `INTEGRATIONS_MODE` pueda seguir en `off`: son independientes de los simuladores.

## Permisos locales
`apiworking:read` (clientes, cajas, lista de ventas), `apiworking:sell` (vender y crear clientes),
`apiworking:void` (anular), `apiworking:configure` (ver todas las cajas, documentos y series de Apiworking para decidir qué autorizar; solo lectura).
Los tienen Administrador de clínica (todos) y Cajero (`read`, `sell`, `void`); Recepción, `read` y `sell`. La plataforma no.

## Puesta en marcha de una clínica con su tenant (p. ej. dental → Dra. Gina Paredes Yauri)
Con la instancia ya creada (`deploy/scripts/instance-new.sh`) y migrada:
1. `NODE_ENV=production npm run db:seed -w apps/api` (catálogo de roles) y
   `npm run db:create-clinic -w apps/api -- --name "Dra. Gina Paredes Yauri" --ruc 10074654016` → anotar `clinicId` en
   `PUBLIC_BOOKING_CLINIC_ID`.
2. En `/etc/apidental/dental.env`: `AUTH_MODE=apiworking`, `APIWORKING_SYSTEM_ID=https://tiendaglowsmile.apiworking.co/`,
   `APIWORKING_AUTHZ_EXPECTED_DATABASE=prod_ti_tiendaglowsmile`, `APIWORKING_AUTHZ_READ=true` y `APIWORKING_AUTHZ_WRITE=false`.
   Reiniciar. Crear además un administrador local de respaldo: `npm run db:create-admin -w apps/api -- --email …`.
3. La persona entra con su usuario de Apiworking (queda en «acceso pendiente») y luego se le asigna el rol:
   `npm run db:grant-role -w apps/api -- --username <usuario> --role CLINIC_ADMIN [--clinic <id>]`.
4. Con **lecturas**: en **Ventas → Configuración de Apiworking** (solo administrador) se ven TODAS las cajas, tipos de documento y
   series que Apiworking informa, con los valores listos para copiar. Fijarlos en las listas autorizadas del `.env` junto con
   `APIWORKING_WAREHOUSE_ID` y `APIWORKING_UNIT_ID` (estos dos no se pueden consultar: los indica el responsable del tenant).
   Mientras las listas estén vacías, la pantalla de ventas no muestra cajas (falla cerrado).
5. **Primera escritura** (solo con la aprobación escrita del titular): `APIWORKING_AUTHZ_WRITE=true`; enviar **una** venta de prueba y verificarla en Apiworking. (Si se quiere, `APIWORKING_MAX_REAL_OPERATIONS` pone un tope por 24 h.)

## Supuestos por confirmar con la primera llamada real (sin evidencia)
Apiworking no entregó contrato. Esto se implementó según la guía y el ejemplo recibido, y **hay que validarlo**:
- `GET /api/Cliente/clientes`: no figura entre los 13 endpoints validados. Se asume el sobre `{ codResponse, data: [...] }`,
  que acepta el `Authorization: Bearer` (el ejemplo curl no lo traía) y que `displayStart=1` es la primera página.
- Que `id_cliente` de esa lista es el `idCliente` que espera `registro-documento` (la guía usa el `id` de `ClienteDoc`).
- Que `idComprobante` (respuesta de `registro-documento`) es el `idDocumentoPago` de `controlPagos` y `anular`.
- Parámetros y fechas (`dd-mm-aaaa`) de `GET /api/Facturacion` para buscar el documento tras un resultado desconocido, y
  que un documento anulado muestra un `estado` que contiene «anul».
- `idUnidadMedida`: los documentos reales salieron con `"15"` (ZZ); `"1"` (NIU) nunca se envió. Se toma de `APIWORKING_UNIT_ID`.
- Factura (RUC): sin probar. El RUC rechaza en `ClienteDoc` (problema conocido del proveedor).
- El pago no se aplica al registrar (problema conocido): el panel lo muestra como «Cobro sin confirmar».

## Límites conocidos
- Sin renovación de token externo: al vencer o reiniciar la API, el usuario debe volver a entrar.
- Una cuenta deshabilitada en Apiworking conserva su sesión local hasta que esta venza; al volver a entrar se rechaza.
- El login de Apiworking comparte el límite estricto por IP del login local; no hay bloqueo por cuenta (lo aplica Apiworking).
- Las ventas son por concepto libre (`idProducto` 0): no hay catálogo de productos sincronizado.

## Reapertura y cierre de caja (`AperturaCajaChica`, `PostCierreCajaChica`)

`AperturaCajaChica` es la **reapertura** de una caja cerrada; el cierre usa `PostCierreCajaChica`.

- Ruta: `POST /api/CajaChica/AperturaCajaChica/{base_datos}`; el tenant de la URL es siempre `APIWORKING_AUTHZ_EXPECTED_DATABASE`.
- Cuerpo: `idPersona` e `idUsuario` (del login: `id_persona`, `id_usuario`), `idTurno` (por defecto `1`; `GET /api/CajaChica/turnos`), `idCaja` y `cadenaDetalle` = `idMoneda^montoInicial` (`1^0` = soles, sin efectivo; `1^100` = S/ 100).
- Éxito: `codResponse` 1 con `data[0]` (`result`, `duplicado`, `msjDocumentos`); `duplicado` no se interpreta: el estado real se comprueba con `consulta-aperturada`.
- Controles: permiso `apiworking:cash`, solo cajas autorizadas, **en un clic** (desde Caja chica: «Abrir caja» / «Cerrar caja»; sin vista previa ni aprobación, `approvedHash` opcional), escrituras activadas, tope de operaciones (cuenta junto con las ventas), nunca abre una caja ya abierta, un solo envío sin reintentos y resultado dudoso sin reenvío.
- Endpoints locales: `GET /v1/apiworking/cash`, `POST /v1/apiworking/cash/preview`, `POST /v1/apiworking/cash/open`.
- Cierre: `POST /api/CajaChica/PostCierreCajaChica/{base_datos}` con `{idPersona, idTurno, idCaja, cadenaDetalle:"", cadenaCierre:"", cadenaCierreDetalle:"", idCajaSel:"", ip:"", usuario:<id_usuario>}`; las cadenas van vacías (confirmado por el responsable de Apiworking). Solo si la caja figura abierta; mismos controles que la reapertura. Locales: `POST /v1/apiworking/cash/close-preview` y `/cash/close`. El cierre no se puede deshacer desde esta aplicación.
- Sin validar: varias monedas en `cadenaDetalle` (se supone `~`, como `cadenaPago`).

## Listas autorizadas: opcionales (2026-11-02)

`APIWORKING_AUTHORIZED_CASH_REGISTERS`, `APIWORKING_AUTHORIZED_DOCUMENT_TYPES` y `APIWORKING_AUTHORIZED_SERIES` son **opcionales**. Vacías, vale lo que Apiworking informa a la cuenta con la que se inició sesión (el tenant ya está fijado y en cada vista previa y envío se revalidan caja, tipo, serie y forma de pago contra Apiworking). Con ids, restringen aún más. Con `APIWORKING_AUTHZ_WRITE=true` solo se exige `APIWORKING_AUTHZ_READ=true`; el almacén y la unidad de medida (`APIWORKING_WAREHOUSE_ID`, `APIWORKING_UNIT_ID`) se piden únicamente al **vender**, no para reabrir ni cerrar caja.

## Alta de cliente por documento (`ClienteDoc`)

- Ruta: `POST /api/Cliente/ClienteDoc?tipoDoc=…&nroDoc=…`, sin cuerpo; devuelve `data.id` (= `idCliente`). `tipoDoc`: DNI 1, RUC 6, CE 4, pasaporte 7, no domiciliado 0. Según la guía está validado con DNI; con un RUC de prueba dio `codResponse` 0 sin motivo.
- Controles: permiso `apiworking:sell`, vista previa con SHA-256 aprobado, escrituras activadas, tope de operaciones compartido (ventas, caja y clientes), no envía si el documento ya existe, un solo envío sin reintentos, verificación volviendo a listar y resultado dudoso sin reenvío. El número de documento viaja en la URL: no se registra ni se audita (solo el tipo y el id resultante).
- Una lista de clientes vacía («No se pudo listar clientes» / «No se encontraron…») se trata como lista vacía.
- Locales: `POST /v1/apiworking/clients/preview` y `POST /v1/apiworking/clients`.

## Espejo local de clientes (`apiworking_customers`)

Los clientes creados por `ClienteDoc` se guardan también en la BD local (tenant, id de Apiworking, tipo y número de documento, nombre de referencia). La búsqueda une la lista de Apiworking con el espejo (sin duplicar por id) y, si Apiworking no responde, sirve solo el espejo (`offline: true`; el panel lo avisa). La lista de Apiworking sigue siendo la fuente de verdad del id; si la consulta devuelve 0 filas con `displayStart=1` se reintenta con `0`. Una venta puede usar un cliente del espejo.

## Almacén y unidad de medida automáticos

Al vender, el almacén (`idAlmacen`) es la sucursal del usuario en Apiworking (`data.id_sucursal` del login) y la unidad de medida (`idUnidadMedida`) es `"1"` (NIU), según el responsable del tenant. `APIWORKING_WAREHOUSE_ID` y `APIWORKING_UNIT_ID` solo sobrescriben esos valores. Nota de la guía: `"1"` no se había enviado nunca en real (los documentos reales usaron `"15"`, ZZ); se confirma con la primera venta de prueba.

## Cobrar desde la cita o el paciente, y contingencia

- **Cobrar:** `GET /v1/apiworking/billing-draft?appointmentId=…|patientId=…` prellena la venta (cliente por el documento del paciente, servicio y precio de referencia de la cita). La venta queda enlazada a la cita (`apiworking_sales.appointment_id`, una sola vigente por cita, solo citas ATTENDED) y al paciente. Botones «Cobrar en Apiworking» en la cita atendida y en la ficha del paciente (solo con `AUTH_MODE=apiworking`). El módulo de cobros simulado (`Charge`) solo existe con `INTEGRATIONS_MODE=mock` y no interviene.
- **Caja oficial:** la de Apiworking. La caja local solo se usa en **contingencia**.
- **Contingencia** (`POST /v1/apiworking/contingency`, permisos `apiworking:sell` y `cashbox:write`): Apiworking no responde → la venta se guarda como `PENDING_ISSUE` («cobrado en contingencia: por emitir») y el dinero entra en la caja local (movimiento de ingreso, idempotente por `requestKey`; con la caja local cerrada no se registra nada). No se llama a Apiworking. Los clientes se buscan en el espejo local (`GET /v1/apiworking/clients?local=1`, sin sesión de Apiworking); todo cliente usado en una venta queda en el espejo.
- **Emitir después:** «Emitir en Apiworking» completa ESA fila (`pendingSaleId`): el cliente y el monto no pueden cambiar, se elige caja, tipo, serie y forma de pago y se confirma la fecha del documento (por defecto la original; **decisión tributaria pendiente con el contador**). Mismo flujo controlado: vista previa, aprobación, un envío, sin reintentos ni envío automático. Un rechazo deja la venta otra vez por emitir.
- **Aviso:** el comprobante interno NO es un comprobante de SUNAT; los plazos de SUNAT corren hasta emitirlo.
- El estado «cobro sin confirmar» de Apiworking se ignora por ahora (decisión del responsable).

## Pago del documento (`registrar-pago`)
`registro-documento` no aplica el pago. Se aplica con `POST /api/Facturacion/registrar-pago`
(`{ idDocumentoPago, cadenaPago: [{ idMetodoPago, importePago }], vuelto }`; responde `data.result = 1` e `idComprobante`)
**automáticamente, en el mismo paso que la venta** (como CERDS), con la forma de pago y el total (sin vuelto). Es parte de la
venta: no cuenta aparte en el tope. El intento se audita antes (`APIWORKING_PAYMENT_ATTEMPT`, `auto: true`). Respuesta buena →
«Pagado». Si falla, el documento queda registrado, el pago «pendiente» y el motivo a la vista; no se reintenta solo. Las ventas
de contingencia no se pagan en Apiworking: el dinero ya entró en la caja local.

## Nombres por DNI al crear un paciente
En «Nuevo paciente», con cuenta de Apiworking y el permiso `apiworking:sell`, al completar un DNI de 8 dígitos el panel llama a
`POST /v1/apiworking/clients/lookup`. Orden: (1) si el cliente ya está en el espejo local o en la lista de Apiworking con su nombre
real, se usa **sin escribir nada**; (2) si no, `ClienteDoc` (que además lo crea como cliente en Apiworking: envío real, un solo
intento, auditado y contado en el tope). El nombre completo se separa en nombres, apellido paterno y materno (los dos últimos
términos son apellidos) como **sugerencia**: la persona la revisa. Un fallo nunca impide crear el paciente (se escribe a mano).
