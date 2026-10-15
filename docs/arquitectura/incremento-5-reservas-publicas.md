# Incremento 5: landing pública y solicitudes de cita

**Estado:** implementado y probado en local (API, landing y pantalla «Solicitudes» del panel; 10 pruebas e2e nuevas). **No desplegado.** Los pacientes pueden **solicitar** una cita desde la web pública; **recepción la confirma** desde el panel. Nada de internet crea fichas de pacientes ni ocupa la agenda por sí solo.

## Decisiones
- **Solicitud, no reserva.** La web pública escribe en una tabla propia (`booking_requests`). Recepción la atiende: elige o crea al paciente, asigna odontólogo y horario libre, y recién ahí nace la cita (`RESERVED`) con el flujo normal.
- **Raíz del dominio.** `https://dental.apiworking.com.pe/` sirve la landing (archivos estáticos, `apps/site/`); `/admin/` sigue siendo el panel y `/v1/` la API (mismo origen: sin CORS).
- **Servicios del catálogo.** La landing lee nombre, duración y precio de referencia de `agenda_services` activos.
- **Apagado por defecto.** Las rutas públicas existen solo si `PUBLIC_BOOKING_CLINIC_ID` apunta a una clínica; si no, responden 404.

## Seguridad y privacidad
- Sin sesión, solo estas rutas; límites por IP (`Throttle`) más estrictos que el resto, un campo señuelo (`website`) y un máximo de solicitudes pendientes por celular.
- La respuesta pública **nunca** devuelve datos de pacientes, odontólogos ni citas: solo horas libres y una referencia (`SOL-XXXXXX`).
- Se pide aceptar el aviso de privacidad (`acceptPrivacy: true`); se guarda la fecha de aceptación. Los datos de la solicitud son administrativos (nombre, documento opcional, celular, correo opcional, nota sin datos clínicos).
- La solicitud no bloquea el horario: dos personas pueden pedir el mismo; recepción resuelve.

## Contrato
### Público (sin sesión) — `/v1/public/booking`
| Método y ruta | Cuerpo / consulta | Respuesta |
|---|---|---|
| `GET /info` | — | `{ clinic: { name }, branches: [{ id, name, address }], services: [{ id, name, durationMinutes, priceText }] }` (`priceText` = «S/ 80.00» o `null`) |
| `GET /availability` | `branchId`, `serviceId`, `from`, `to?` (`YYYY-MM-DD`, máx. 14 días) | `{ durationMinutes, days: [{ date, times: ["09:00", …] }] }` (hora de Lima; unión de los odontólogos) |
| `POST /requests` | `{ branchId, serviceId, date, time, firstName, lastName, secondLastName?, documentType? ('DNI'\|'CE'\|'PASSPORT'), documentNumber?, mobile, email?, notes?, acceptPrivacy: true, website? }` | `201 { reference }` · `400` datos inválidos · `409 { code: 'SLOT_UNAVAILABLE' }` · `429` demasiadas solicitudes |

### Personal (JWT, permiso `appointment:manage`) — `/v1/booking-requests`
| Método y ruta | Cuerpo / consulta | Respuesta |
|---|---|---|
| `GET /` | `status` (`PENDING` por defecto, `ACCEPTED`, `REJECTED`, `ALL`), `limit` | lista de solicitudes (ver abajo) |
| `GET /count` | — | `{ pending }` |
| `POST /:id/accept` | `{ patientId, dentistUserId, startsAt (ISO), roomId? }` | la cita creada (igual que `POST /appointments`); la solicitud pasa a `ACCEPTED` |
| `POST /:id/reject` | `{ reason }` (mín. 3 caracteres) | la solicitud en `REJECTED` |

Solicitud: `{ id, reference, status, statusLabel, createdAt, branch: { id, name }, service: { id, name, durationMinutes }, desiredStartsAt, date, time, person: { firstName, lastName, secondLastName, documentType, documentNumber, mobile, email }, notes, appointmentId, patientId, rejectReason, decidedAt }`.

## Pendiente
- Aviso al paciente (WhatsApp/SMS/correo) al aceptar o rechazar: hoy lo contacta recepción.
- Depuración de solicitudes cerradas (retención) en el mantenimiento diario.
