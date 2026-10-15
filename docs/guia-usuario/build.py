#!/usr/bin/env python3
"""Genera la guía de usuario de ApiDental desde una sola fuente de contenido.

  python3 docs/guia-usuario/build.py            -> README.md e index.html (imágenes por ruta relativa, para el repositorio)
  python3 docs/guia-usuario/build.py --embed X  -> X (HTML único con las imágenes incrustadas, para compartir)

Las capturas están en img/ y se tomaron con el panel y los datos demo (todo ficticio).
"""
import base64, html, pathlib, re, sys

HERE = pathlib.Path(__file__).parent
IMG = HERE / 'img'

# ------------------------------------------------------------------ contenido
# Bloques: ('p', texto) · ('steps', [texto…]) · ('img', archivo, pie) · ('note', texto) · ('warn', texto) · ('list', [texto…])
# El texto admite **negrita** y `código`.

ROLES = [
    # id, nombre, cuenta demo, resumen
    ('recepcion', 'Recepción', 'recepcion.demo@apidental.test', 'Agenda, citas, datos del paciente y cobros.'),
    ('odontologo', 'Odontólogo', 'odontologa.demo@apidental.test', 'Atiende a sus pacientes y registra el odontograma.'),
    ('asistente', 'Asistente', 'asistente.demo@apidental.test', 'Apoyo: consulta la agenda y los datos básicos.'),
    ('director', 'Director clínico', 'director.demo@apidental.test', 'Autoridad clínica de la clínica; consulta agenda y pacientes.'),
    ('cajero', 'Cajero', 'cajero.demo@apidental.test', 'Caja, comprobantes y puntos de fidelización.'),
    ('admin', 'Administrador de clínica', 'admin.dev@apidental.test', 'Todo lo de recepción y caja, más la administración de su clínica.'),
    ('plataforma', 'Administrador de plataforma', 'admin.dev@apidental.test', 'Opera la plataforma. No ve datos de pacientes.'),
]

MATRIX_HEAD = ['Rol', 'Agenda', 'Pacientes', 'Historia clínica y odontograma', 'Caja', 'Comprobantes', 'Fidelización']
MATRIX = [
    ['Recepción', 'Gestiona', 'Datos completos', 'No', 'Cobra', 'Ve', 'Ve'],
    ['Odontólogo', 'Ve e inicia la atención', 'Lectura', 'Sí, de sus pacientes', 'No', 'No', 'No'],
    ['Asistente', 'Ve', 'Datos básicos', 'No', 'No', 'No', 'No'],
    ['Director clínico', 'Ve', 'Lectura', 'Solo por la API, con justificación', 'No', 'No', 'No'],
    ['Cajero', 'Ve', 'Datos básicos', 'No', 'Cobra', 'Emite y concilia', 'Canjea puntos'],
    ['Administrador de clínica', 'Gestiona', 'Datos completos', 'No', 'Cobra', 'Emite y concilia', 'Canjea puntos'],
    ['Administrador de plataforma', 'No', 'No', 'No', 'No', 'No', 'No'],
]

COMMON = [
    ('h3', 'Ingresar'),
    ('steps', ['Abra `https://dental.apiworking.com.pe/admin/` en su navegador.',
               'Escriba su **correo** y su **contraseña**. Con «Mostrar contraseña» puede comprobar lo que escribe.',
               'Pulse **Ingresar**.']),
    ('img', 'comun-01-login.jpg', 'Pantalla de ingreso.'),
    ('note', 'Después de **5 intentos fallidos** seguidos la cuenta se bloquea 15 minutos. Si olvidó su contraseña, pida a su administrador que la restablezca.'),
    ('h3', 'Elegir dónde trabaja'),
    ('p', 'Si su usuario tiene más de una clínica o sede, aparece esta pantalla. Elija una. Para cambiar más tarde use **Cambiar sede**, abajo a la izquierda del menú.'),
    ('img', 'comun-02-elegir-sede.jpg', 'Selección de clínica y sede. Con un solo lugar de trabajo se entra directo.'),
    ('h3', 'Cómo está organizada la pantalla'),
    ('list', ['**Menú de la izquierda.** Solo muestra lo que su rol puede usar, por eso cada persona ve opciones distintas.',
              '**Barra amarilla «DEMO — NO VÁLIDO PARA SUNAT».** Indica que cobros, comprobantes, puntos y reseñas son una simulación con datos ficticios. Nada se envía a SUNAT ni a Apiworking. Siempre está visible.',
              '**Cerrar sesión**, abajo a la izquierda. Ciérrela siempre en equipos compartidos.']),
    ('h3', 'Cuando aparece «Acceso denegado»'),
    ('img', 'comun-03-acceso-denegado.jpg', 'Su rol no incluye esa información.'),
    ('p', 'Significa que su rol no puede ver esa pantalla. No es un error. Si necesita ese acceso, consulte con el administrador de su clínica.'),
]

SECTIONS = {
'recepcion': [
    ('p', 'Recepción organiza la agenda, mantiene los datos del paciente y cobra la atención.'),
    ('h3', '1. Revisar el día'),
    ('p', 'La pantalla **Hoy** resume las citas del día: cuántas hay, cuántas faltan por confirmar y las ausencias. Los nombres de la lista abren la ficha del paciente.'),
    ('img', 'recepcion-01-hoy.jpg', 'Hoy, vista de recepción.'),
    ('h3', '2. Ver la agenda'),
    ('p', 'En **Agenda** elija la fecha, la vista (día o semana en lista) y el odontólogo. Cada cita muestra la hora, el paciente, el servicio, el consultorio y su estado.'),
    ('img', 'recepcion-02-agenda.jpg', 'Agenda del día por odontólogo.'),
    ('h3', '3. Reservar una cita'),
    ('steps', ['Pulse **Nueva cita** (en la agenda o en la ficha del paciente).',
               'Busque al **paciente** por DNI, nombre o celular (mínimo 2 caracteres) y elíjalo.',
               'Elija **servicio**, **odontólogo** y **fecha**. Aparecen los **horarios disponibles**; elija uno.',
               'Si hace falta, agregue una nota administrativa y pulse **Reservar cita**.']),
    ('img', 'recepcion-03-nueva-cita.jpg', 'Formulario de nueva cita.'),
    ('note', 'Solo se ofrecen horarios libres según el horario del odontólogo, su consultorio y la duración del servicio. No se puede reservar encima de otra cita.'),
    ('h3', '4. Gestionar una cita'),
    ('p', 'Pulse una cita de la agenda para abrir su detalle.'),
    ('img', 'recepcion-04-cita.jpg', 'Detalle de la cita con sus acciones.'),
    ('list', ['**Confirmar**: cuando el paciente avisó que viene. Pasa de «Reservado» a «Confirmado».',
              '**Reprogramar**: elija otro horario disponible. La cita guarda cuántas veces se movió.',
              '**Cancelar cita**: pide un motivo (mínimo 3 caracteres).',
              '**Marcar ausencia**: disponible desde la hora de inicio, si el paciente no llegó. Pide un motivo.',
              '**Ver paciente**: abre su ficha.']),
    ('p', 'Estados de una cita: Reservado → Confirmado → Atendido. También puede terminar en Cancelado o Ausente.'),
    ('h3', '5. Buscar al paciente y ver su ficha'),
    ('p', 'En **Pacientes** busque por DNI, nombre o celular y pulse el nombre.'),
    ('img', 'recepcion-05-pacientes.jpg', 'Búsqueda de pacientes.'),
    ('p', 'La ficha reúne la identificación, las citas y la tarjeta de fidelización simulada con su saldo de puntos.'),
    ('img', 'recepcion-06-ficha-paciente.jpg', 'Ficha del paciente.'),
    ('warn', 'Aún **no hay pantalla para crear o editar pacientes** en el panel. Eso se hace hoy por la API. La historia clínica y el odontograma no son visibles para recepción.'),
    ('h3', '6. Cobrar una atención'),
    ('steps', ['Cuando el odontólogo atendió la cita, ábrala en la agenda y pulse **Registrar cobro**. También puede entrar por **Caja** y elegir el cobro pendiente.',
               'En **Caja** verá todos los cobros con su fecha, paciente, concepto, monto y estado.']),
    ('img', 'recepcion-07-caja.jpg', 'Caja: lista de cobros. Se puede filtrar por estado.'),
    ('steps', ['Abra el cobro pendiente.', 'Elija el **medio de pago**: efectivo, tarjeta, transferencia o Yape/Plin.', 'Pulse **Registrar pago**.']),
    ('img', 'recepcion-08-cobro-pendiente.jpg', 'Cobro pendiente de pago.'),
    ('note', 'Si el cobro se creó por error, use **Anular cobro**. El cobro queda anulado y visible en la lista; no se borra.'),
    ('h3', '7. Ver el comprobante'),
    ('p', 'Al pagar, se encolan los puntos de fidelización y la solicitud de reseña (simulados). El comprobante aparece debajo del cobro, siempre con la marca **«DEMO — NO VÁLIDO PARA SUNAT»**.'),
    ('img', 'recepcion-09-cobro-pagado.jpg', 'Cobro pagado.'),
    ('img', 'recepcion-10-comprobante.jpg', 'Boleta simulada emitida, con subtotal, IGV y total.'),
    ('p', 'En **Comprobantes** está la lista de todos los emitidos, con su estado.'),
    ('img', 'recepcion-11-comprobantes.jpg', 'Lista de comprobantes.'),
    ('p', 'Abajo está la **cola de integraciones**: lo que quedó pendiente de enviar (comprobantes, puntos y reseñas) y qué pasó con cada tarea.'),
    ('img', 'recepcion-12-cola.jpg', 'Cola de integraciones.'),
    ('note', 'Recepción **ve** los comprobantes. Emitirlos, reintentarlos o conciliarlos lo hace Caja.'),
],
'odontologo': [
    ('p', 'El odontólogo atiende a los pacientes con los que tiene relación asistencial vigente y registra el odontograma. Solo ve la historia clínica de esos pacientes.'),
    ('h3', '1. Revisar el día'),
    ('img', 'odontologo-01-hoy.jpg', 'Hoy, vista del odontólogo. No tiene Caja ni Comprobantes.'),
    ('h3', '2. Iniciar la atención'),
    ('steps', ['En **Agenda** abra la cita del paciente.', 'Pulse **Iniciar atención**. Se abre una visita clínica y la cita pasa a «Atendido».']),
    ('img', 'odontologo-02-iniciar-atencion.jpg', 'Cita lista para iniciar la atención.'),
    ('note', 'El botón aparece desde **30 minutos antes** de la hora de la cita y hasta **6 horas después** de que termina. Fuera de esa ventana, solo se ve «Ver paciente».'),
    ('h3', '3. La ficha de atención'),
    ('p', 'Arriba aparecen las **alertas** del paciente: alergias registradas, avisos y si tiene consentimiento clínico vigente. Léalas antes de empezar.'),
    ('img', 'odontologo-03-ficha.jpg', 'Ficha de atención con alertas de alergia y consentimiento.'),
    ('p', 'Más abajo están los diagnósticos, los procedimientos, la evolución y el resumen del odontograma de la visita.'),
    ('img', 'odontologo-04-ficha-secciones.jpg', 'Secciones de la ficha.'),
    ('warn', 'En el panel, **diagnósticos, procedimientos y evolución se muestran en solo lectura**. Hoy se registran por la API. Lo que sí se edita desde el panel es el odontograma.'),
    ('h3', '4. Registrar el odontograma'),
    ('p', 'Desde la ficha pulse **Ver odontograma**, o entre por la ficha del paciente. Según el caso verá:'),
    ('list', ['**Iniciar odontograma**: si el paciente no tiene ninguno.',
              '**Actualizar odontograma**: abre un borrador nuevo a partir de la última versión guardada.',
              '**Corregir la versión guardada**: para corregir un error. Pide el motivo y, al guardar, su contraseña.']),
    ('img', 'odontologo-05-odontograma.jpg', 'Editor del odontograma: dentición, pinceles y estado del guardado.'),
    ('p', 'Cada pieza (numeración FDI) se dibuja con su raíz y, en premolares y molares, su cara oclusal. Para marcar:'),
    ('steps', ['**Toque una pieza** para elegirla. Se abre su panel a la derecha.',
               'Elija un **pincel** (Caries, Restauración, Sellante, Fractura u Otro hallazgo) y toque una **superficie** en la cruz del panel: V vestibular, L lingual o palatina, M mesial, D distal, O oclusal o incisal.',
               'Para quitar un hallazgo, toque la misma superficie otra vez o use el pincel **Quitar**.',
               'En el panel también puede indicar el **estado de la pieza** (presente, ausente, sin erupcionar, implante o resto radicular), las **marcas** (corona, endodoncia, prótesis) y una nota.']),
    ('img', 'odontologo-06-odontograma-pieza.jpg', 'Pieza 16 elegida, con la cruz de superficies y su detalle.'),
    ('img', 'odontologo-07-odontograma-marcado.png', 'Caries marcadas en las superficies oclusal y mesial de la pieza 16. Se pintan sobre el propio diente.'),
    ('list', ['**Dentición:** cambie entre permanente, temporal y mixta con el selector de arriba.',
              '**Se guarda solo.** El indicador «Guardado» confirma que el borrador está a salvo. No necesita pulsar nada para no perder el trabajo.',
              'Con las flechas del teclado puede moverse entre piezas y con Enter elegirla.']),
    ('h3', '5. Guardar la versión'),
    ('p', 'Al terminar, escriba las notas generales si las hay y pulse **Guardar versión**. La versión queda **inmutable**: no se puede cambiar. Para modificar algo después, se abre otra versión y se conserva el historial completo.'),
    ('img', 'odontologo-08-odontograma-guardar.jpg', 'Notas generales, Descartar borrador y Guardar versión.'),
    ('p', 'Si abrió el borrador por error, pulse **Descartar borrador**: pide un motivo, y la última versión guardada no cambia.'),
    ('img', 'odontologo-09-descartar.jpg', 'Descartar el borrador.'),
    ('note', 'Se confirma con su contraseña únicamente al guardar una **corrección**. Esa confirmación no es una firma digital, legal ni clínica.'),
    ('warn', 'El odontograma registra **lo que usted observa o declara**. El sistema no sugiere diagnósticos ni tratamientos. El formato clínico está **por validar** y no se declara cumplimiento de normas del MINSA.'),
    ('h3', '6. La ficha del paciente'),
    ('p', 'En **Atención clínica** están todas las visitas del paciente, abiertas o cerradas, con acceso directo a cada ficha y al odontograma.'),
    ('img', 'odontologo-10-paciente.jpg', 'Ficha del paciente con su historial de visitas.'),
],
'asistente': [
    ('p', 'El asistente apoya la atención. Consulta la agenda y los datos básicos de los pacientes.'),
    ('img', 'asistente-01-hoy.jpg', 'Hoy, vista del asistente. El menú solo tiene Hoy, Agenda y Pacientes.'),
    ('p', 'En la ficha del paciente ve su identificación y sus citas. La historia clínica, la evolución y el odontograma no están disponibles para este rol.'),
    ('img', 'asistente-02-paciente.jpg', 'Ficha del paciente: información clínica reservada al odontólogo.'),
    ('img', 'asistente-03-sin-acceso.jpg', 'Si abre una ficha clínica por un enlace, verá «Acceso denegado».'),
    ('note', 'El asistente puede consultar la agenda, pero no reserva, reprograma ni cancela citas. Eso lo hace Recepción.'),
],
'director': [
    ('p', 'El director clínico es la autoridad clínica de la clínica. En el panel consulta la agenda y los datos de los pacientes.'),
    ('img', 'director-01-hoy.jpg', 'Hoy, vista del director clínico.'),
    ('img', 'director-02-paciente.jpg', 'Ficha del paciente. La historia clínica queda reservada al odontólogo que atiende.'),
    ('warn', 'El director puede leer la historia de **un paciente por vez**, de forma excepcional, con justificación, confirmación de contraseña y registro de auditoría. Esa lectura **todavía no tiene pantalla** en el panel y se hace por la API.'),
],
'cajero': [
    ('p', 'El cajero registra los pagos, emite y concilia los comprobantes simulados y canjea puntos de fidelización.'),
    ('img', 'cajero-01-hoy.jpg', 'Hoy, vista del cajero. El menú incluye Caja y Comprobantes.'),
    ('h3', '1. Cobrar'),
    ('p', 'En **Caja** están todos los cobros. Abra un cobro **pendiente**, elija el medio de pago y pulse **Registrar pago**. Es el mismo flujo que en Recepción (ver la pantalla de Caja allí).'),
    ('h3', '2. Emitir el comprobante simulado'),
    ('steps', ['Abra un cobro **pagado** que aún no tenga comprobante.',
               'Elija **Boleta** o **Factura**. La factura pide un RUC de 11 dígitos y la razón social, ambos ficticios.',
               'Elija el **escenario de simulación**: emitido de inmediato, pendiente, rechazado o con reintento. Sirve para mostrar cómo responde cada caso.',
               'Pulse **Emitir comprobante simulado**.']),
    ('p', 'El comprobante nace con la marca **«DEMO — NO VÁLIDO PARA SUNAT»**, un número correlativo y un estado.'),
    ('h3', '3. Comprobantes, cola y conciliación'),
    ('p', 'En **Comprobantes** el cajero tiene dos botones que Recepción no ve:'),
    ('list', ['**Procesar cola**: entrega al proveedor simulado lo pendiente (comprobantes, puntos y reseñas).',
              '**Conciliar pendientes**: consulta el estado real de los comprobantes que quedaron «Enviado» o «Requiere conciliación».']),
    ('img', 'cajero-02-comprobantes.jpg', 'Comprobantes con Procesar cola y Conciliar pendientes.'),
    ('img', 'cajero-03-cola.jpg', 'Cola de integraciones: procesado, en cola u omitido, con el motivo.'),
    ('h4', 'Qué significa cada estado de comprobante'),
    ('list', ['**Emitido**: aceptado por el proveedor simulado.',
              '**Enviado**: se envió y falta la confirmación. Use Conciliar.',
              '**Requiere conciliación**: no se sabe el resultado. Use Conciliar.',
              '**Error reintentable**: falló por algo temporal. Use Reintentar en el detalle del cobro.',
              '**Rechazado**: el proveedor simulado lo rechazó y muestra el motivo.']),
    ('note', 'Si un comprobante fue rechazado, se puede emitir uno nuevo desde el mismo cobro; tendrá otro número.'),
    ('note', 'Procesar cola y Reintentar son seguros de repetir: un cobro no genera dos comprobantes ni suma los puntos dos veces.'),
    ('h3', '4. Canjear puntos'),
    ('p', 'En la ficha del paciente, la tarjeta **Fidelización** muestra su nivel, su saldo y el estado de su tarjeta NFC (simulada). Si el cajero está autorizado, escriba los puntos en **Canjear puntos** y pulse **Canjear**. Un paciente solo acumula puntos si autorizó la fidelización.'),
],
'admin': [
    ('p', 'El administrador de clínica tiene el mismo panel que Recepción y Caja juntos: agenda, pacientes, cobros, comprobantes y fidelización. Además administra a las personas de su clínica.'),
    ('img', 'admin-01-contexto.jpg', 'Este usuario tiene dos asignaciones: administración de la plataforma y administración de la clínica.'),
    ('img', 'admin-02-hoy.jpg', 'Hoy, con la clínica elegida.'),
    ('p', 'Para las tareas del día siga las guías de **Recepción** y **Cajero**.'),
    ('warn', '**Usuarios, sedes, roles e invitaciones no tienen pantalla** en el panel todavía. Se administran por la API. El envío de invitaciones requiere configurar el canal de entrega, que hoy está desactivado.'),
],
'plataforma': [
    ('p', 'El administrador de plataforma opera la plataforma. Por diseño **no tiene acceso a datos de pacientes**. Si el mismo usuario también administra una clínica, elija esa asignación al ingresar o con **Cambiar sede**.'),
    ('img', 'plataforma-01-hoy.jpg', 'En la administración de la plataforma solo existe la pantalla Hoy.'),
],
}

FAQ = [
    ('No veo el botón «Iniciar atención».', 'Solo aparece para el odontólogo de la cita, desde 30 minutos antes de su hora y hasta 6 horas después de terminar, y mientras la cita no esté cancelada ni marcada como ausencia.'),
    ('Me aparece «Acceso denegado».', 'Su rol no incluye esa pantalla. Consulte la tabla de roles. Si la necesita, pida el cambio a su administrador.'),
    ('Mi sesión se cerró sola.', 'Por seguridad la sesión caduca. Ingrese de nuevo. En equipos compartidos use siempre Cerrar sesión.'),
    ('No encuentro al paciente.', 'Busque por DNI, nombre o celular con al menos 2 caracteres. Puede haber dos fichas parecidas con documentos distintos: el sistema las avisa y no las fusiona.'),
    ('Un comprobante dice «DEMO — NO VÁLIDO PARA SUNAT».', 'Es correcto. Esta versión simula la facturación para mostrar el flujo. No hay conexión con SUNAT ni con Apiworking, y esos comprobantes no tienen validez tributaria.'),
    ('Un comprobante quedó en «Error reintentable» o «Requiere conciliación».', 'Es un caso previsto. Pida a Caja que use Reintentar o Conciliar. Nada se duplica.'),
    ('Guardé un odontograma con un error.', 'Una versión guardada no se modifica. Abra «Corregir la versión guardada», indique el motivo y confirme con su contraseña. Queda el historial de ambas versiones.'),
]

PENDING = [
    'Crear y editar pacientes, consentimientos y adjuntos desde el panel (hoy por la API).',
    'Registrar diagnósticos, procedimientos y evolución desde el panel (hoy en solo lectura).',
    'Planes de tratamiento, presupuestos, cuotas y saldos.',
    'Apertura y cierre de caja, pagos parciales y cuentas por cobrar.',
    'Reportes y tablero de gestión.',
    'Recordatorios por WhatsApp o SMS y confirmación de asistencia por el paciente.',
    'Letreros NFC y métricas de reseñas, tarjeta en Wallet, cumpleaños y referidos.',
    'Administración de usuarios, sedes e invitaciones desde el panel.',
]

# ------------------------------------------------------------------ utilidades

def inline(t, md=False):
    t = html.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    return t


def md_inline(t):
    return t


def img_src(name, embed):
    p = IMG / name
    if not embed:
        return f'img/{name}'
    mime = 'image/png' if name.endswith('.png') else 'image/jpeg'
    return f'data:{mime};base64,' + base64.b64encode(p.read_bytes()).decode()


def blocks_html(blocks, embed):
    out = []
    for b in blocks:
        k = b[0]
        if k == 'p': out.append(f'<p>{inline(b[1])}</p>')
        elif k == 'h3': out.append(f'<h3>{inline(b[1])}</h3>')
        elif k == 'h4': out.append(f'<h4>{inline(b[1])}</h4>')
        elif k == 'steps': out.append('<ol class="steps">' + ''.join(f'<li>{inline(s)}</li>' for s in b[1]) + '</ol>')
        elif k == 'list': out.append('<ul>' + ''.join(f'<li>{inline(s)}</li>' for s in b[1]) + '</ul>')
        elif k == 'note': out.append(f'<aside class="callout note"><span class="tag">Tenga en cuenta</span><p>{inline(b[1])}</p></aside>')
        elif k == 'warn': out.append(f'<aside class="callout limit"><span class="tag">Todavía no</span><p>{inline(b[1])}</p></aside>')
        elif k == 'img': out.append(f'<figure><img src="{img_src(b[1], embed)}" alt="{html.escape(b[2])}" loading="lazy"><figcaption>{inline(b[2])}</figcaption></figure>')
    return '\n'.join(out)


def blocks_md(blocks):
    out = []
    for b in blocks:
        k = b[0]
        if k == 'p': out.append(b[1] + '\n')
        elif k == 'h3': out.append(f'### {b[1]}\n')
        elif k == 'h4': out.append(f'#### {b[1]}\n')
        elif k == 'steps': out.append('\n'.join(f'{i}. {s}' for i, s in enumerate(b[1], 1)) + '\n')
        elif k == 'list': out.append('\n'.join(f'- {s}' for s in b[1]) + '\n')
        elif k == 'note': out.append(f'> **Tenga en cuenta.** {b[1]}\n')
        elif k == 'warn': out.append(f'> **Todavía no.** {b[1]}\n')
        elif k == 'img': out.append(f'![{b[2]}](img/{b[1]})\n*{b[2]}*\n')
    return '\n'.join(out)


# ------------------------------------------------------------------ salida HTML

CSS = """
:root{--bg:#f6f8f9;--surface:#ffffff;--fg:#141e26;--muted:#475965;--line:#d9e1e6;--brand:#0f7889;--brand-strong:#0d6070;--brand-tint:#e6f4f6;--note:#e8f1fb;--note-line:#2b6cb0;--limit:#fff4db;--limit-line:#c27803;--code:#eef3f5;--shadow:0 1px 2px rgba(20,30,38,.06),0 8px 24px rgba(20,30,38,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f161c;--surface:#16212a;--fg:#e8eef2;--muted:#a3b3bf;--line:#2a3944;--brand:#4cc0d2;--brand-strong:#79d3e0;--brand-tint:#12323a;--note:#14283d;--note-line:#6aa6e8;--limit:#3a2c0a;--limit-line:#e2a436;--code:#1e2c36;--shadow:none;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f161c;--surface:#16212a;--fg:#e8eef2;--muted:#a3b3bf;--line:#2a3944;--brand:#4cc0d2;--brand-strong:#79d3e0;--brand-tint:#12323a;--note:#14283d;--note-line:#6aa6e8;--limit:#3a2c0a;--limit-line:#e2a436;--code:#1e2c36;--shadow:none;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:5rem}
body{margin:0;background:var(--bg);color:var(--fg);font:400 1rem/1.65 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:0 4rem}
h1,h2,h3,h4{font-family:"Manrope","Inter",system-ui,sans-serif;line-height:1.2;text-wrap:balance;margin:0}
a{color:var(--brand-strong)}
code{font:500 .9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.1em .35em;border-radius:4px}
.wrap{max-width:74rem;margin:0 auto;display:grid;grid-template-columns:15rem minmax(0,1fr);gap:3rem}
@media (max-width:900px){.wrap{grid-template-columns:minmax(0,1fr);gap:0}}
nav.toc{position:sticky;top:env(safe-area-inset-top,0px);align-self:start;max-height:100vh;overflow:auto;padding:2rem 0}
nav.toc .brandline{font:800 1.25rem "Manrope",sans-serif;color:var(--brand-strong);margin-bottom:.15rem}
nav.toc small{display:block;color:var(--muted);margin-bottom:1.25rem}
nav.toc a{display:block;padding:.4rem .6rem;border-radius:6px;text-decoration:none;color:var(--fg);font-size:.95rem}
nav.toc a:hover{background:var(--brand-tint)}
nav.toc .grp{font:700 .72rem "Inter",sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:1.1rem .6rem .3rem}
@media (max-width:900px){nav.toc{position:static;max-height:none;padding:1.25rem 0 .5rem;display:flex;flex-wrap:wrap;gap:.25rem}nav.toc .brandline,nav.toc small,nav.toc .grp{flex-basis:100%;margin:.2rem 0}nav.toc a{border:1px solid var(--line);background:var(--surface)}}
main{min-width:0;padding-top:2rem}
.hero{padding:1rem 0 2rem;border-bottom:1px solid var(--line)}
.hero h1{font-size:clamp(2rem,5vw,3rem);font-weight:800;letter-spacing:-.02em}
.hero p{max-width:42rem;color:var(--muted);font-size:1.1rem;margin:1rem 0 0}
section.role{padding-top:3.5rem}
section.role>h2{font-size:clamp(1.6rem,3.5vw,2.1rem);font-weight:800;letter-spacing:-.01em;display:flex;flex-wrap:wrap;align-items:baseline;gap:.6rem 1rem}
.who{font:500 .9rem "Inter",sans-serif;color:var(--muted)}
.who code{white-space:nowrap}
h3{font-size:1.25rem;font-weight:700;margin:2.25rem 0 .6rem}
h4{font-size:1.05rem;margin:1.5rem 0 .4rem}
p,li{max-width:46rem}
ol.steps{padding-left:0;list-style:none;counter-reset:s;display:grid;gap:.6rem;margin:.75rem 0}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:2rem minmax(0,1fr);gap:.75rem;align-items:start}
ol.steps li::before{content:counter(s);display:grid;place-items:center;width:1.7rem;height:1.7rem;border-radius:50%;background:var(--brand);color:#fff;font:700 .85rem "Manrope",sans-serif;margin-top:.1rem}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) ol.steps li::before{color:#08242a}}
:root[data-theme="dark"] ol.steps li::before{color:#08242a}
ul{padding-left:1.25rem}li{margin:.3rem 0}
figure{margin:1.25rem 0 1.75rem}
figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);background:var(--surface)}
figcaption{margin-top:.5rem;color:var(--muted);font-size:.9rem}
.callout{max-width:46rem;border-radius:8px;padding:.85rem 1rem;margin:1.1rem 0;border:1px solid var(--line)}
.callout p{margin:.25rem 0 0}.callout .tag{font:700 .72rem "Inter",sans-serif;letter-spacing:.08em;text-transform:uppercase}
.callout.note{background:var(--note);border-color:var(--note-line)}.callout.note .tag{color:var(--note-line)}
.callout.limit{background:var(--limit);border-color:var(--limit-line)}.callout.limit .tag{color:var(--limit-line)}
.tablewrap{overflow-x:auto;margin:1.25rem 0;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
table{border-collapse:collapse;width:100%;min-width:46rem;font-size:.92rem}
th,td{padding:.65rem .8rem;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
thead th{background:var(--brand-tint);font:700 .8rem "Inter",sans-serif;letter-spacing:.03em}
tbody tr:last-child td{border-bottom:0}tbody th{font-weight:600}
.faq details{border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:.2rem 1rem;margin:.6rem 0;max-width:46rem}
.faq summary{cursor:pointer;font-weight:600;padding:.6rem 0}
.faq summary:focus-visible,a:focus-visible{outline:3px solid var(--brand);outline-offset:2px;border-radius:4px}
.foot{margin-top:4rem;padding-top:1.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
"""


def build_html(embed):
    roles_nav = ''.join(f'<a href="#{r[0]}">{html.escape(r[1])}</a>' for r in ROLES)
    sections = []
    for rid, name, mail, summary in ROLES:
        sections.append(
            f'<section class="role" id="{rid}"><h2>{html.escape(name)} <span class="who">Cuenta demo: <code>{html.escape(mail)}</code></span></h2>'
            f'<p>{html.escape(summary)}</p>{blocks_html(SECTIONS[rid], embed)}</section>')
    matrix = '<div class="tablewrap"><table><thead><tr>' + ''.join(f'<th scope="col">{html.escape(h)}</th>' for h in MATRIX_HEAD) + '</tr></thead><tbody>' + \
        ''.join('<tr><th scope="row">' + html.escape(r[0]) + '</th>' + ''.join(f'<td>{html.escape(c)}</td>' for c in r[1:]) + '</tr>' for r in MATRIX) + '</tbody></table></div>'
    faq = '<div class="faq">' + ''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q, a in FAQ) + '</div>'
    pending = '<ul>' + ''.join(f'<li>{html.escape(p)}</li>' for p in PENDING) + '</ul>'
    return f"""<title>Guía de ApiDental</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@700;800&display=swap">
<style>{CSS}</style>
<div class="wrap">
<nav class="toc" aria-label="Contenido">
<div class="brandline">ApiDental</div><small>Guía de uso por rol</small>
<div class="grp">General</div><a href="#primeros">Primeros pasos</a><a href="#roles">Qué puede hacer cada rol</a>
<div class="grp">Por rol</div>{roles_nav}
<div class="grp">Ayuda</div><a href="#faq">Preguntas frecuentes</a><a href="#pendiente">Lo que falta</a>
</nav>
<main>
<header class="hero"><h1>Guía de uso de ApiDental</h1>
<p>Cómo trabajar en el panel de la clínica según su rol: qué ve, qué puede hacer y cómo hacerlo, con capturas de la versión demo. Los pacientes, citas y montos de las capturas son ficticios.</p></header>
<section class="role" id="primeros"><h2>Primeros pasos</h2>{blocks_html(COMMON, embed)}</section>
<section class="role" id="roles"><h2>Qué puede hacer cada rol</h2>
<p>El menú solo muestra lo que su rol permite. Esta tabla resume los permisos del panel actual.</p>{matrix}</section>
{''.join(sections)}
<section class="role" id="faq"><h2>Preguntas frecuentes</h2>{faq}</section>
<section class="role" id="pendiente"><h2>Lo que todavía no está en el panel</h2><p>Estas funciones existen como objetivo del producto, pero no están disponibles en esta versión o se usan por la API:</p>{pending}</section>
<p class="foot">Versión demostrativa: cobros, comprobantes, puntos y reseñas son simulaciones con datos ficticios, sin conexión con SUNAT ni con Apiworking. El formato clínico del odontograma está por validar.</p>
</main></div>"""


def build_md():
    out = ['# Guía de uso de ApiDental', '',
           'Cómo trabajar en el panel según su rol, con capturas de la versión demo. Los pacientes, citas y montos son ficticios. Generado por `build.py`.', '',
           '## Contenido', '', '- [Primeros pasos](#primeros-pasos)', '- [Qué puede hacer cada rol](#qué-puede-hacer-cada-rol)'] + \
          [f'- [{r[1]}](#{re.sub(r"[^a-záéíóúñ0-9 -]", "", r[1].lower()).replace(" ", "-")})' for r in ROLES] + \
          ['- [Preguntas frecuentes](#preguntas-frecuentes)', '- [Lo que todavía no está en el panel](#lo-que-todavía-no-está-en-el-panel)', '',
           '## Primeros pasos', '', blocks_md(COMMON), '## Qué puede hacer cada rol', '',
           '| ' + ' | '.join(MATRIX_HEAD) + ' |', '|' + '---|' * len(MATRIX_HEAD)] + \
          ['| ' + ' | '.join(r) + ' |' for r in MATRIX] + ['']
    for rid, name, mail, summary in ROLES:
        out += [f'## {name}', '', f'Cuenta demo: `{mail}`. {summary}', '', blocks_md(SECTIONS[rid])]
    out += ['## Preguntas frecuentes', ''] + [f'**{q}**  \n{a}\n' for q, a in FAQ]
    out += ['## Lo que todavía no está en el panel', ''] + [f'- {p}' for p in PENDING] + ['']
    return '\n'.join(out)


if __name__ == '__main__':
    if '--embed' in sys.argv:
        target = pathlib.Path(sys.argv[sys.argv.index('--embed') + 1])
        target.write_text(build_html(True), encoding='utf-8')
        print('embed:', target, round(target.stat().st_size / 1e6, 1), 'MB')
    else:
        (HERE / 'README.md').write_text(build_md(), encoding='utf-8')
        (HERE / 'index.html').write_text('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + build_html(False) + '</html>', encoding='utf-8')
        print('README.md e index.html generados')
