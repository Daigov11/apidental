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
3. **Ventas** (`/v1/apiworking/sales*`): contexto (caja, apertura, tipos, series, formas de pago, siempre dentro de las listas
   autorizadas) → **vista previa** con el JSON exacto y su SHA-256 → **envío único** a `registro-documento` con la aprobación
   (`approvedHash`) y una clave de idempotencia → **verificar** (`controlPagos`, `Facturacion`) → **conciliar** (decisión humana)
   → **anular** (con motivo).

## Controles (de la guía)
| Control | Cómo |
|---|---|
| Lista cerrada de método y ruta | `ROUTES` en `apiworking.client.ts`; parámetros de consulta exactos por ruta |
| Solo el servidor habla con Apiworking | el navegador nunca ve el JWT externo |
| Interruptores separados, apagados por defecto | `APIWORKING_AUTHZ_READ` / `APIWORKING_AUTHZ_WRITE` (escribir exige leer) |
| Listas cerradas para escribir | cajas, tipos de documento y series autorizados; vacío = nada |
| Tope de envíos reales | `APIWORKING_MAX_REAL_OPERATIONS` por 24 h (0 = ninguno) |
| Sin reintentos en escrituras | una sola llamada; un 5xx/tiempo agotado = **resultado desconocido** → `PENDING_RECONCILIATION` |
| Lectura estricta | `codResponse` distinto de 1 es rechazo; campo ausente es error; ids grandes como texto; importes sin `parseFloat` |
| Documento, cobro y anulación separados | `docStatus`, `paymentStatus`, `voidStatus`. **Registrar no aplica el pago**: el cobro solo pasa a «confirmado» si `controlPagos` cubre el total |
| Nada sensible en registros ni auditoría | solo ruta, estado y duración; la auditoría no guarda tokens, contraseñas ni cuerpos |
| Host permitido | `APIWORKING_BASE_URL` solo `*.apiworking.pe` / `*.apiworking.co` (https en producción) |

## Variables de entorno
Ver `.env.example`. Mínimo para el login: `AUTH_MODE=apiworking`, `APIWORKING_SYSTEM_ID`, `APIWORKING_AUTHZ_EXPECTED_DATABASE`.
Para leer: `APIWORKING_AUTHZ_READ=true`. Para escribir además: `APIWORKING_AUTHZ_WRITE=true`, `APIWORKING_MAX_REAL_OPERATIONS>0`,
`APIWORKING_AUTHORIZED_CASH_REGISTERS`, `_DOCUMENT_TYPES`, `_SERIES`, `APIWORKING_WAREHOUSE_ID` y `APIWORKING_UNIT_ID`.
Las rutas reales solo requieren que `INTEGRATIONS_MODE` pueda seguir en `off`: son independientes de los simuladores.

## Permisos locales
`apiworking:read` (clientes, cajas, lista de ventas), `apiworking:sell` (preparar, enviar, verificar, conciliar),
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
5. **Primera escritura** (solo con la aprobación escrita del titular): `APIWORKING_AUTHZ_WRITE=true` y
   `APIWORKING_MAX_REAL_OPERATIONS=1`; enviar **una** venta de prueba; verificarla en Apiworking; recién entonces subir el tope.

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

## Apertura de caja (`AperturaCajaChica`)

- Ruta: `POST /api/CajaChica/AperturaCajaChica/{base_datos}`; el tenant de la URL es siempre `APIWORKING_AUTHZ_EXPECTED_DATABASE`.
- Cuerpo: `idPersona` e `idUsuario` (del login: `id_persona`, `id_usuario`), `idTurno` (por defecto `1`; `GET /api/CajaChica/turnos`), `idCaja` y `cadenaDetalle` = `idMoneda^montoInicial` (`1^0` = soles, sin efectivo; `1^100` = S/ 100).
- Éxito: `codResponse` 1 con `data[0]` (`result`, `duplicado`, `msjDocumentos`); `duplicado` no se interpreta: el estado real se comprueba con `consulta-aperturada`.
- Controles: permiso `apiworking:cash`, solo cajas autorizadas, vista previa con SHA-256 aprobado, escrituras activadas, tope de operaciones (cuenta junto con las ventas), nunca abre una caja ya abierta, un solo envío sin reintentos y resultado dudoso sin reenvío.
- Endpoints locales: `GET /v1/apiworking/cash`, `POST /v1/apiworking/cash/preview`, `POST /v1/apiworking/cash/open`.
- Sin validar: varias monedas en `cadenaDetalle` (se supone `~`, como `cadenaPago`) y el cierre de caja (no hay endpoint conocido).
