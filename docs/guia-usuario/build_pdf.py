#!/usr/bin/env python3
"""Genera la guía de uso de ApiDental en PDF (paso a paso, A4) con el navegador Brave/Chrome sin interfaz.

  python3 docs/guia-usuario/build_pdf.py            -> Guia-ApiDental.pdf (+ copia en apps/admin/public/guia/)
  python3 docs/guia-usuario/build_pdf.py --html X   -> solo el HTML intermedio en X

Cada tarea es una lista de pasos numerados con su captura al lado. Las capturas (img/) son del panel con datos demo ficticios;
se recortan con CSS (sin tocar los archivos) para mostrar solo el contenido.
"""
import base64, datetime, html, os, pathlib, re, shutil, struct, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).parent
IMG = HERE / 'img'
ROOT = HERE.parent.parent
BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def dims(p: pathlib.Path):
    b = p.read_bytes()
    if b[:8] == b'\x89PNG\r\n\x1a\n':
        return struct.unpack('>II', b[16:24])
    i = 2
    while i < len(b):  # JPEG: busca el marcador SOF
        if b[i] != 0xFF: i += 1; continue
        m = b[i + 1]
        if m in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack('>HH', b[i + 5:i + 9]); return w, h
        i += 2 + struct.unpack('>H', b[i + 2:i + 4])[0]
    raise ValueError(p)


def data_uri(p):
    return f"data:{'image/png' if p.suffix == '.png' else 'image/jpeg'};base64," + base64.b64encode(p.read_bytes()).decode()


def b(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    return re.sub(r'`(.+?)`', r'<code>\1</code>', t)


def fig(name, cap, left=248, top=0, bottom=0, right=0, cls=''):
    """Captura recortada con CSS. left/top/bottom/right = píxeles a quitar de la imagen original."""
    w, h = dims(IMG / name)
    cw, ch = w - left - right, h - top - bottom
    return (f'<figure class="{cls}"><div class="crop" style="aspect-ratio:{cw}/{ch}"><img src="{data_uri(IMG / name)}" alt="{html.escape(cap)}" '
            f'style="width:{w / cw * 100:.3f}%;left:{-left / cw * 100:.3f}%;top:{-top / ch * 100:.3f}%"></div><figcaption>{b(cap)}</figcaption></figure>')


def task(title, steps, figs, note=None, tip=None):
    ol = ''.join(f'<li>{b(s)}</li>' for s in steps)
    extra = ''
    if note: extra += f'<p class="note"><strong>Importante.</strong> {b(note)}</p>'
    if tip: extra += f'<p class="tip"><strong>Sepa que</strong> {b(tip)}</p>'
    return f'<section class="task"><h3>{b(title)}</h3><div class="cols"><div class="steps"><ol>{ol}</ol>{extra}</div><div class="shots">{"".join(figs)}</div></div></section>'


def role(rid, name, mail, what, tasks):
    return (f'<section class="role" id="{rid}"><header class="rolehead"><h2>{b(name)}</h2><p>{b(what)}</p>'
            f'<p class="acct">Cuenta de la demostración: <code>{mail}</code></p></header>{"".join(tasks)}</section>')


# ------------------------------------------------------------------ contenido
START = [
    task('Ingresar al panel', [
        'Abra **https://dental.apiworking.com.pe/admin/** en su navegador.',
        'Escriba su **correo** y su **contraseña**. «Mostrar contraseña» permite revisar lo escrito.',
        'Pulse **Ingresar**.'],
        [fig('comun-01-login.jpg', 'Pantalla de ingreso.', left=500, right=500, top=110, bottom=110)],
        note='Tras 5 intentos fallidos seguidos, la cuenta se bloquea 15 minutos.'),
    task('Elegir clínica y sede', [
        'Si su usuario tiene más de un lugar de trabajo, aparece esta pantalla. **Elija uno**.',
        'Si solo tiene uno, entra directo.',
        'Para cambiar más tarde, pulse **Cambiar sede**, abajo a la izquierda.'],
        [fig('comun-02-elegir-sede.jpg', 'Selección de clínica y sede.', left=500, right=500, top=240, bottom=200)]),
    task('Conocer la pantalla', [
        'El **menú de la izquierda** muestra solo lo que su rol puede usar: por eso cada persona ve opciones distintas.',
        '**Hoy** es la pantalla de inicio: resume las citas del día, cuántas faltan por confirmar, las ausencias y las próximas citas.',
        'La **barra amarilla «DEMO — NO VÁLIDO PARA SUNAT»** indica que cobros, comprobantes, puntos y reseñas son una simulación con datos ficticios. Siempre está visible.',
        'Abajo a la izquierda están **Guía de uso (PDF)**, que descarga esta guía, **Cambiar sede** y **Cerrar sesión**. Use siempre Cerrar sesión en equipos compartidos.',
        'Si ve **«Acceso denegado»**, su rol no incluye esa pantalla. No es un error: consulte con su administrador.'],
        [fig('menu-cajero.png', 'Menú del cajero. Asistente, odontólogo y director ven solo Hoy, Agenda y Pacientes.', left=0, top=0, bottom=0, cls='narrow'),
         ]),
]

MATRIX = [
    ('Recepción', 'Gestiona citas y solicitudes web', 'Datos completos; crea pacientes', 'Solo lectura', 'Cobra', 'Ve', 'Ve'),
    ('Odontólogo', 'Ve; inicia la atención', 'Lectura', 'Sí (sus pacientes)', '—', '—', '—'),
    ('Asistente', 'Ve', 'Datos básicos', '—', '—', '—', '—'),
    ('Director clínico', 'Ve', 'Lectura', 'Solo por la API', '—', '—', '—'),
    ('Cajero', 'Ve', 'Datos básicos', '—', 'Cobra', 'Emite y concilia', 'Canjea puntos'),
    ('Admin. de clínica', 'Gestiona citas y solicitudes web', 'Datos completos; crea pacientes', 'Ve y registra (auditado)', 'Cobra', 'Emite y concilia', 'Canjea puntos'),
    ('Admin. de plataforma', '—', '—', '—', '—', '—', '—'),
]

RECEPCION = [
    task('Reservar una cita', [
        'En **Agenda** pulse **Nueva cita** (también está en la ficha del paciente).',
        'En **Paciente**, haga clic: aparecen pacientes para elegir. O escriba su DNI, nombre o celular (desde 2 caracteres) para filtrar, y elíjalo.',
        'Elija el **servicio** y el **odontólogo**.',
        'Elija la **fecha**. Aparecen los **horarios disponibles**; pulse uno.',
        'Si hace falta, escriba una nota administrativa (sin datos clínicos).',
        'Pulse **Reservar cita**.'],
        [fig('recepcion-02-agenda.jpg', 'Agenda del día: elija fecha, vista y odontólogo.', top=96, bottom=0),
         fig('recepcion-03-nueva-cita.jpg', 'Formulario de nueva cita.', left=980, right=18, top=70, bottom=75)],
        tip='solo se ofrecen horarios libres según el horario del odontólogo, su consultorio y la duración del servicio.'),
    task('Si el paciente todavía no existe', [
        'En **Paciente**, escriba lo que sabe de la persona. Si no aparece nadie, se muestra **Crear paciente nuevo**: púlselo.',
        'Se abre el formulario sobre la cita, ya con lo que escribió. Complete **nombres** y **apellido paterno** (obligatorios).',
        'Si lo tiene, agregue documento (DNI, carné de extranjería o pasaporte), fecha de nacimiento, celular y correo.',
        'Pulse **Crear paciente**. Queda elegido en la cita: siga con el servicio y el horario.'],
        [fig('recepcion-03b-paciente-no-encontrado.jpg', 'La búsqueda no encontró a nadie.', left=980, right=18, top=80, bottom=470),
         fig('recepcion-03c-nuevo-paciente.jpg', 'Formulario de nuevo paciente.', left=488, right=502, top=62, bottom=62)],
        note='antes de crear, el sistema revisa si ya existe. Con el **mismo documento** no crea otra ficha y ofrece **Usar a este paciente**. Si hay nombres, celulares o correos parecidos, elija a la persona o **Crear de todos modos**. Para un menor, registre luego a su representante por la API.'),
    task('La página pública: así piden cita los pacientes', [
        'Los pacientes entran a **https://dental.apiworking.com.pe/** (la raíz del sitio; el panel sigue en `/admin/`).',
        'Ven los servicios con su duración y precio de referencia, y las sedes.',
        'En **Solicite su cita** eligen sede y servicio, un día y un horario libre, y dejan sus datos: nombres, apellido y celular. Documento y correo son opcionales. Deben aceptar el aviso de privacidad.',
        'Al enviar reciben una **referencia** («SOL-XXXXXX»). Su pedido **no es una cita confirmada**: la clínica los contactará.'],
        [fig('publica-01-inicio.jpg', 'Página de inicio de la clínica.', left=200, right=215, top=64, bottom=250),
         fig('publica-02-horarios.jpg', 'El paciente elige día y horario libre.', left=640, right=215, top=100, bottom=0)],
        note='enviar el formulario **no reserva** el horario ni crea al paciente. Eso lo hace recepción al atender la solicitud. Dos personas pueden pedir el mismo horario: recepción resuelve.'),
    task('Atender las solicitudes de la página web', [
        'Entre a **Solicitudes**. El número naranja indica cuántas hay pendientes.',
        'Revise los datos del pedido: paciente, celular, servicio y horario pedido.',
        'Pulse **Atender**. Se abre un panel con el resumen del pedido.',
        'En **Paciente**, elija a la persona si ya existe, o pulse **Crear paciente nuevo**: el formulario ya trae lo que escribió.',
        'Elija el **odontólogo**. Si el horario pedido sigue libre, aparece marcado; si no, elija otro.',
        'Pulse **Confirmar cita**. La cita queda **Reservado**: confírmela desde la **Agenda** cuando hable con el paciente.',
        'Si no se puede atender, pulse **Rechazar** y escriba el motivo.'],
        [fig('recepcion-13-solicitudes.jpg', 'Solicitudes pendientes.', left=248, top=96, bottom=340),
         fig('recepcion-14-atender.jpg', 'Atender: datos del pedido, paciente y odontólogo.', left=990, right=18, top=70, bottom=200)],
        tip='puede filtrar por **Aceptadas**, **Rechazadas** o **Todas** para ver el historial.'),
    task('Confirmar, reprogramar, cancelar o marcar ausencia', [
        'En **Agenda**, pulse la cita para abrir su detalle.',
        '**Confirmar:** cuando el paciente avisó que viene.',
        '**Reprogramar:** elija otro horario disponible.',
        '**Cancelar cita:** escriba el motivo (mínimo 3 caracteres) y confirme.',
        '**Marcar ausencia:** disponible desde la hora de inicio, si no llegó. También pide motivo.',
        '**Ver paciente:** abre su ficha.'],
        [fig('recepcion-04-cita.jpg', 'Detalle de la cita y sus acciones.', left=980, right=18, top=80, bottom=240)],
        tip='una cita pasa por Reservado → Confirmado → Atendido. También puede terminar en Cancelado o Ausente.'),
    task('Buscar o crear pacientes y ver su ficha', [
        'Entre a **Pacientes**. La lista aparece sola, ordenada por apellido, sin escribir nada.',
        'Para buscar, escriba el DNI, el nombre o el celular. **Desde 2 caracteres** la lista se filtra mientras escribe.',
        'Con **Estado** puede ver los pacientes **Activos** o **Inactivos**.',
        'Pulse el nombre para abrir la ficha: datos, **citas** y tarjeta de **fidelización** con su saldo de puntos.',
        'Si no existe, pulse **Nuevo paciente** (arriba a la derecha) o **Crear a «texto»**.',
        'En **Atención clínica** (insignia **Solo lectura**) puede consultar las visitas y el odontograma, sin editarlos.'],
        [fig('recepcion-05-pacientes.jpg', 'Lista de pacientes: aparece al abrir y se filtra al escribir.', top=96, bottom=140),
         fig('recepcion-06-ficha-paciente.jpg', 'Ficha del paciente.', top=100, bottom=0)],
        tip='al reservar una cita, el cuadro **Paciente** también muestra pacientes apenas hace clic en él, sin escribir; desde 2 caracteres filtra.',
        note='aún no hay pantalla para **editar** los datos de un paciente ya creado, ni para consentimientos y adjuntos (se hacen por la API). La historia clínica y el odontograma se ven **solo en lectura** (ficha del paciente, bloque «Atención clínica»); recepción no puede registrar ni modificar nada ahí.'),
    task('Cobrar una atención', [
        'Cuando el odontólogo atendió la cita, ábrala en **Agenda** y pulse **Registrar cobro**. También puede entrar por **Caja**.',
        'En **Caja** vea todos los cobros; filtre por **Estado** si lo necesita.',
        'Abra el cobro **Pendiente de pago**.',
        'Elija el **medio de pago**: efectivo, tarjeta, transferencia o Yape/Plin.',
        'Pulse **Registrar pago**. Si se creó por error, use **Anular cobro** (queda anulado, no se borra).'],
        [fig('recepcion-07-caja.jpg', 'Caja: lista de cobros.', top=96, bottom=180),
         fig('recepcion-08-cobro-pendiente.jpg', 'Cobro pendiente de pago.', top=96, bottom=230)]),
    task('Ver comprobantes y la cola', [
        'Al pagar, el comprobante aparece debajo del cobro, siempre con **«DEMO — NO VÁLIDO PARA SUNAT»**.',
        'En **Comprobantes** vea la lista con su estado: Emitido, Enviado, Requiere conciliación, Error reintentable o Rechazado.',
        'Más abajo está la **cola de integraciones**: lo pendiente de enviar (comprobantes, puntos y reseñas) y qué pasó con cada tarea.'],
        [fig('recepcion-10-comprobante.jpg', 'Boleta simulada emitida.', top=105, bottom=40),
         fig('recepcion-11-comprobantes.jpg', 'Lista de comprobantes.', top=96, bottom=200)],
        note='Recepción **ve** los comprobantes. Emitirlos, reintentarlos o conciliarlos lo hace Caja.'),
]

ODONTOLOGO = [
    task('Iniciar la atención', [
        'En **Agenda**, pulse la cita del paciente.',
        'Pulse **Iniciar atención**. Se abre una visita clínica y la cita pasa a «Atendido».'],
        [fig('odontologo-02-iniciar-atencion.jpg', 'Cita lista para iniciar la atención.', left=980, right=18, top=80, bottom=300)],
        note='el botón aparece desde **30 minutos antes** de la cita y hasta **6 horas después** de que termina. Fuera de ese rango solo se ve «Ver paciente».'),
    task('Leer la ficha de atención', [
        'Lea primero las **alertas**: alergias, avisos y si hay **consentimiento clínico vigente**.',
        'Si falta la evaluación de alergias, pulse **Registrar evaluación**: indique «No refiere alergias conocidas» o registre la alergia.',
        'Más abajo están **Diagnósticos**, **Procedimientos** y **Evolución**, y el resumen del **Odontograma**.',
        'Pulse **Ver odontograma** para registrarlo.'],
        [fig('odontologo-03-ficha.jpg', 'Ficha de atención con alertas.', top=96, bottom=200)],
        note='el consentimiento clínico no se registra desde el panel todavía: si falta, pida a recepción o administración que lo registre. Los registros son declaraciones suyas; el sistema no recomienda ni decide.'),
    task('Registrar diagnósticos, procedimientos y evolución', [
        'En **Diagnósticos** pulse **Agregar**, escriba el diagnóstico y elija **Presuntivo** o **Definitivo**. Con **Corregir** o **Retirar** (pide motivo) se conserva el historial.',
        'En **Procedimientos** pulse **Agregar** y elija uno del catálogo. Al terminarlo, pulse **Marcar realizado** (o **Cancelar**, con motivo).',
        'En **Evolución** escriba lo observado y pulse **Guardar borrador**. Cuando esté lista, pulse **Cerrar evolución** y confirme con su contraseña (no es una firma digital).',
        'Al terminar, pulse **Cerrar la visita**. Si hay un procedimiento abierto o la evolución sigue en borrador, la pantalla le indica qué falta.'],
        note='solo el odontólogo responsable de la visita puede registrar, y solo mientras la visita está abierta. Receta e indicaciones al paciente aún no existen en el sistema.'),
    task('Ver el historial del paciente', [
        'Abra al paciente desde **Pacientes** o desde la cita.',
        'En **Atención clínica** están todas sus visitas, abiertas o cerradas.',
        'Pulse **Abrir ficha** en una visita, o **Ver odontograma**.'],
        [fig('odontologo-10-paciente.jpg', 'Ficha del paciente con su historial de visitas.', top=420, bottom=0)],
        tip='solo ve la historia clínica de los pacientes con los que tiene relación asistencial vigente. No tiene Caja ni Comprobantes.'),
    task('Registrar el odontograma', [
        'Pulse **Iniciar odontograma** (si no hay ninguno) o **Actualizar odontograma**. Se abre un borrador.',
        'Elija la **dentición**: permanente, temporal o mixta.',
        '**Toque una pieza** (numeración FDI). Se abre su panel a la derecha.',
        'Elija un **pincel**: Caries, Restauración, Sellante, Fractura u Otro hallazgo.',
        'Toque una **superficie** en la cruz del panel (V, L, M, D, O). Se pinta sobre el diente. Tóquela otra vez, o use **Quitar**, para borrarla.',
        'En el panel puede indicar el **estado de la pieza** (ausente, sin erupcionar, implante, resto radicular), las **marcas** (corona, endodoncia, prótesis) y una nota.'],
        [fig('odontologo-05-odontograma.jpg', 'Barra de herramientas del odontograma.', top=300, bottom=300),
         fig('odontologo-06-odontograma-pieza.jpg', 'Pieza elegida con su cruz de superficies.', top=40, bottom=250),
         fig('odontologo-07-odontograma-marcado.png', 'Caries marcadas en la pieza 16.', left=0)],
        tip='se **guarda solo**: el indicador «Guardado» confirma que el borrador está a salvo. Con el teclado: flechas para moverse y Enter para elegir.'),
    task('Guardar, descartar o corregir', [
        'Escriba las **notas generales** si las hay.',
        'Pulse **Guardar versión**. La versión queda **inmutable**.',
        'Si abrió el borrador por error, pulse **Descartar borrador**, escriba el motivo y confirme.',
        'Para cambiar una versión ya guardada, pulse **Corregir la versión guardada**: pide motivo y, al guardar, su contraseña.',
        'Con **Descargar PDF** obtiene el odontograma para imprimirlo.'],
        [fig('odontologo-08-odontograma-guardar.jpg', 'Notas, Descartar borrador y Guardar versión.', top=420, bottom=0),
         fig('odontologo-09-descartar.jpg', 'Descartar el borrador (pide motivo).', left=488, right=500, top=190, bottom=185)],
        note='el odontograma registra **lo que usted observa**. El sistema no sugiere diagnósticos ni tratamientos. Formato clínico por validar.'),
]

ASISTENTE = [
    task('Consultar la agenda y los datos básicos', [
        'Entre a **Agenda** para ver las citas por odontólogo.',
        'Entre a **Pacientes**, busque a la persona y abra su ficha.',
        'Verá su identificación y sus citas. La historia clínica y el odontograma **no están disponibles** para este rol.'],
        [fig('asistente-02-paciente.jpg', 'Ficha del paciente para el asistente.', top=96, bottom=130),
         fig('asistente-03-sin-acceso.jpg', 'Una ficha clínica muestra «Acceso denegado».', top=96, bottom=330)],
        note='el asistente no reserva, reprograma ni cancela citas: eso lo hace Recepción.'),
]

DIRECTOR = [
    task('Consultar la agenda y los pacientes', [
        'Entre a **Agenda** o **Pacientes**, como el asistente.',
        'En el panel no puede abrir la historia clínica de un paciente.'],
        [fig('director-02-paciente.jpg', 'Ficha del paciente (director clínico).', top=96, bottom=130)],
        note='el director puede leer la historia de **un paciente por vez**, de forma excepcional, con justificación, contraseña y registro de auditoría. Esa lectura **todavía no tiene pantalla** y se hace por la API.'),
]

CAJERO = [
    task('Registrar un pago', [
        'Entre a **Caja** y abra el cobro **Pendiente de pago** (o use **Registrar cobro** desde una cita atendida).',
        'Elija el **medio de pago** y pulse **Registrar pago**.',
        'Aparece el aviso «Pago registrado» y el cobro pasa a **Pagado**.'],
        [fig('recepcion-07-caja.jpg', 'Caja: lista de cobros.', top=96, bottom=180),
         fig('recepcion-08-cobro-pendiente.jpg', 'Cobro pendiente.', top=96, bottom=230)]),
    task('Emitir el comprobante simulado', [
        'Abra un cobro **Pagado** que aún no tiene comprobante.',
        'Elija **Boleta** o **Factura**. La factura pide RUC (11 dígitos) y razón social, ambos ficticios.',
        'Elija el **escenario de simulación**: emitido de inmediato, pendiente, rechazado o con reintento.',
        'Pulse **Emitir comprobante simulado**. Nace con la marca **DEMO — NO VÁLIDO PARA SUNAT**.'],
        [fig('cajero-04-emitir.jpg', 'Pago registrado y formulario de emisión.', top=96, bottom=0)],
        tip='si un comprobante fue rechazado, puede emitir uno nuevo desde el mismo cobro; tendrá otro número.'),
    task('Procesar la cola, conciliar y reintentar', [
        'Entre a **Comprobantes**.',
        '**Procesar cola:** entrega al proveedor simulado lo pendiente (comprobantes, puntos y reseñas).',
        '**Conciliar pendientes:** consulta el estado de los que quedaron «Enviado» o «Requiere conciliación».',
        '**Reintentar** (en el detalle del cobro): para un comprobante en «Error reintentable».'],
        [fig('cajero-02-comprobantes.jpg', 'Procesar cola y Conciliar pendientes.', top=96, bottom=230),
         fig('cajero-03-cola.jpg', 'Cola de integraciones.', top=330, bottom=0)],
        tip='repetir estas acciones es seguro: no se duplican comprobantes ni puntos.'),
    task('Canjear puntos de fidelización', [
        'Abra la ficha del paciente en **Pacientes**.',
        'En **Fidelización** vea su nivel, su saldo y su tarjeta NFC (simulada).',
        'Escriba los puntos en **Canjear puntos** y pulse **Canjear**.'],
        [fig('cajero-05-fidelizacion.jpg', 'Tarjeta de fidelización del paciente.', top=225, bottom=130)],
        tip='un paciente solo acumula puntos si autorizó la fidelización.'),
]

ADMIN = [
    task('Trabajar como administrador de clínica', [
        'Al ingresar, elija **Clínica Demo** (la otra opción es la administración de la plataforma).',
        'Tiene el mismo panel que Recepción y Caja juntos. Siga sus guías para agenda, pacientes, cobros, comprobantes y fidelización.',
        'Además puede **ver y registrar** la información clínica de cualquier paciente de la clínica (historia y odontograma). Cada acceso queda auditado. Las acciones propias de una visita (iniciar atención, evoluciones) siguen siendo del odontólogo responsable.',
        'Usuarios, sedes, roles e invitaciones se administran hoy **por la API**; no hay pantalla.'],
        [fig('admin-01-contexto.jpg', 'Dos asignaciones: plataforma y clínica.', left=500, right=500, top=190, bottom=190)]),
    task('Administración de la plataforma', [
        'Elija **Administración de la plataforma**.',
        'Solo existe la pantalla **Hoy**: este rol no ve datos de pacientes por diseño.',
        'Para trabajar con una clínica, pulse **Cambiar sede**.'],
        [fig('plataforma-01-hoy.jpg', 'Administración de la plataforma.', top=0, bottom=430, left=0)]),
]

FAQ = [
    ('Un paciente pidió cita por la web: ¿qué hago?', 'Entre a Solicitudes, pulse Atender y elija paciente, odontólogo y horario. La cita queda Reservado; confírmela desde la agenda. Si no hay horario, rechácela con un motivo y contacte al paciente.'),
    ('No veo «Iniciar atención».', 'Solo aparece al odontólogo de la cita, desde 30 min antes y hasta 6 h después de terminar, y si no está cancelada ni marcada como ausente.'),
    ('No encuentro al paciente.', 'La lista de Pacientes aparece sola; para filtrar escriba desde 2 caracteres (DNI, nombre o celular). Revise también el filtro Estado: puede estar Inactivo. Si no existe, recepción lo crea desde Pacientes o desde la cita.'),
    ('Me dice que el paciente ya existe.', 'Otra ficha tiene el mismo documento o se parece. Use «Usar a este paciente»; el sistema nunca fusiona fichas.'),
    ('Aparece «Acceso denegado».', 'Su rol no incluye esa pantalla. Pida el acceso a su administrador.'),
    ('Mi sesión se cerró sola.', 'Por seguridad la sesión caduca. Ingrese de nuevo.'),
    ('Un comprobante dice «DEMO».', 'Es correcto: la facturación está simulada, sin conexión con SUNAT ni Apiworking.'),
    ('Comprobante en «Error reintentable» o «Requiere conciliación».', 'Pida a Caja que use Reintentar o Conciliar. Nada se duplica.'),
    ('Guardé un odontograma con un error.', 'Una versión guardada no se modifica: use «Corregir la versión guardada» con motivo y contraseña. Se conserva el historial.'),
]
PENDING = [
    'Editar datos de pacientes ya creados; consentimientos, representantes y adjuntos.',
    'Registrar diagnósticos, procedimientos y evolución (hoy solo lectura).',
    'Planes de tratamiento, presupuestos, cuotas y saldos; apertura y cierre de caja.',
    'Reportes y tablero; recordatorios por WhatsApp o SMS; letreros NFC y métricas de reseñas.',
    'Administración de usuarios, sedes e invitaciones.',
    'Aviso automático al paciente (WhatsApp, SMS o correo) cuando recepción acepta o rechaza su solicitud: hoy lo contacta recepción.',
]

CSS = """
@page{size:A4;margin:13mm 13mm 15mm}
:root{--fg:#141e26;--muted:#475965;--line:#d9e1e6;--brand:#0f7889;--brand-d:#0d6070;--tint:#e6f4f6;--note:#fff4db;--noteline:#c27803;--tip:#e8f1fb;--tipline:#2b6cb0}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;color:var(--fg);font:9.6pt/1.45 "Inter","Helvetica Neue",Arial,sans-serif}
h1,h2,h3{font-family:"Manrope","Helvetica Neue",Arial,sans-serif;margin:0;line-height:1.15}
code{font:600 .92em ui-monospace,Menlo,monospace;background:#eef3f5;padding:.05em .3em;border-radius:3px}
.cover{height:262mm;display:flex;flex-direction:column;justify-content:space-between;break-after:page}
.cover .top{display:flex;justify-content:space-between;align-items:center}
.cover img.logo{height:15mm}.cover img.mascot{height:34mm}
.cover h1{font-size:34pt;font-weight:800;letter-spacing:-.02em;margin-top:30mm}
.cover .sub{font-size:14pt;color:var(--muted);margin-top:4mm}
.cover .meta{border-top:2px solid var(--brand);padding-top:5mm;color:var(--muted);font-size:9.5pt}
.cover ol{margin:8mm 0 0;padding:0;list-style:none;columns:2;column-gap:12mm;font-size:10.5pt}
.cover li{padding:1.6mm 0;border-bottom:1px solid var(--line);break-inside:avoid}
.cover li b{color:var(--brand-d)}
h2{font-size:19pt;font-weight:800;color:var(--brand-d)}
.rolehead{border-bottom:2px solid var(--brand);padding-bottom:3mm;margin-bottom:4mm}
.rolehead p{margin:1.5mm 0 0;color:var(--muted)}.rolehead .acct{font-size:8.5pt}
.role{break-before:page}
.role.first{break-before:auto}
.keep{break-inside:avoid}
section.task{break-inside:avoid;margin:0 0 6mm;padding-top:1mm}
h3{font-size:12pt;font-weight:800;color:var(--fg);margin-bottom:2.4mm;padding:1.4mm 3mm;background:var(--tint);border-left:3px solid var(--brand);border-radius:2px}
.cols{display:grid;grid-template-columns:42% 1fr;gap:6mm;align-items:start}
.steps ol{margin:0;padding:0;list-style:none;counter-reset:s}
.steps li{counter-increment:s;position:relative;padding:0 0 2.1mm 7mm}
.steps li::before{content:counter(s);position:absolute;left:0;top:.2mm;width:5mm;height:5mm;border-radius:50%;background:var(--brand);color:#fff;font:800 7.5pt/5mm "Manrope",Arial,sans-serif;text-align:center}
.note,.tip{margin:2mm 0 0;padding:2mm 2.6mm;border-radius:3px;font-size:8.6pt;border-left:3px solid}
.note{background:var(--note);border-color:var(--noteline)}.tip{background:var(--tip);border-color:var(--tipline)}
.shots{display:grid;gap:3mm}
figure{margin:0}
.crop{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:3px;background:#fff}
.crop img{position:absolute;display:block;max-width:none}
figure.narrow{width:34%}
figcaption{font-size:7.6pt;color:var(--muted);margin-top:1mm}
table{border-collapse:collapse;width:100%;font-size:8.4pt;margin-top:3mm;break-inside:avoid}
tr{break-inside:avoid}
th,td{border:1px solid var(--line);padding:1.6mm 2mm;text-align:left;vertical-align:top}
thead th{background:var(--tint);font-size:7.8pt}tbody th{font-weight:700;background:#f7fafb}
.faq dt{font-weight:700;margin-top:2.4mm}.faq dd{margin:.4mm 0 0;color:var(--muted)}
ul.pend{margin:2mm 0 0;padding-left:5mm}
.lead{color:var(--muted);margin:0 0 3mm}
"""


def build():
    logo = data_uri(ROOT / 'brand/logos/apimedical-negro.png')
    mascot = data_uri(ROOT / 'brand/mascota/ardilla-odontologa.png')
    roles_toc = [('Antes de empezar', 'ingresar y elegir sede'), ('Su pantalla y su rol', 'menú y permisos'), ('Recepción', 'citas, solicitudes web, pacientes y cobros'),
                 ('Odontólogo', 'atención y odontograma'), ('Asistente y director clínico', 'consulta'), ('Cajero', 'pagos, comprobantes y puntos'),
                 ('Administradores', 'clínica y plataforma'), ('Preguntas frecuentes', 'y lo que falta')]
    meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre']
    hoy = datetime.date.today()
    fecha = f'{hoy.day} de {meses[hoy.month - 1]} de {hoy.year}'
    commit = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip() or 's/d'
    toc = ''.join(f'<li><b>{b(t)}</b> — {b(s)}</li>' for t, s in roles_toc)
    matrix = ('<table><thead><tr>' + ''.join(f'<th>{h}</th>' for h in ['Rol', 'Agenda', 'Pacientes', 'Historia clínica y odontograma', 'Caja', 'Comprobantes', 'Fidelización']) +
              '</tr></thead><tbody>' + ''.join('<tr><th>' + r[0] + '</th>' + ''.join(f'<td>{c}</td>' for c in r[1:]) + '</tr>' for r in MATRIX) + '</tbody></table>')
    faq = '<dl class="faq">' + ''.join(f'<dt>{b(q)}</dt><dd>{b(a)}</dd>' for q, a in FAQ) + '</dl>'
    pend = '<ul class="pend">' + ''.join(f'<li>{b(p)}</li>' for p in PENDING) + '</ul>'
    body = f"""
<section class="cover"><div class="top"><img class="logo" src="{logo}" alt="APIMedical"><img class="mascot" src="{mascot}" alt=""></div>
<div><h1>Guía de uso de ApiDental</h1><p class="sub">Paso a paso, para cada rol de la clínica</p><ol>{toc}</ol></div>
<div class="meta">Versión demostrativa · Panel: <b>https://dental.apiworking.com.pe/admin/</b> · Actualizada el <b>{fecha}</b> · Versión del panel <b>{commit}</b><br>Los pacientes, citas y montos de las capturas son ficticios. Cobros, comprobantes, puntos y reseñas son simulaciones: no hay conexión con SUNAT ni con Apiworking.</div></section>
<section class="role first" id="inicio"><header class="rolehead"><h2>Antes de empezar</h2><p>Lo que necesita saber todo el personal, sea cual sea su rol.</p></header>{''.join(START[:2])}</section>
<section class="role first" style="margin-top:6mm"><div class="keep"><header class="rolehead"><h2>Su pantalla y su rol</h2><p>El menú muestra solo lo que su rol permite. Resumen del panel actual.</p></header>{matrix}</div><div style="margin-top:6mm">{START[2]}</div></section>
{role('recepcion', 'Recepción', 'recepcion.demo@apidental.test', 'Organiza la agenda, mantiene los datos del paciente y cobra la atención.', RECEPCION)}
{role('odontologo', 'Odontólogo', 'odontologa.demo@apidental.test', 'Atiende a sus pacientes y registra el odontograma.', ODONTOLOGO)}
{role('asistente', 'Asistente', 'asistente.demo@apidental.test', 'Apoya la atención: consulta la agenda y los datos básicos.', ASISTENTE)}
<section class="role first" style="break-before:avoid;margin-top:8mm"><header class="rolehead"><h2>Director clínico</h2><p>Autoridad clínica de la clínica. Cuenta de la demostración: <code>director.demo@apidental.test</code></p></header>{''.join(DIRECTOR)}</section>
{role('cajero', 'Cajero', 'cajero.demo@apidental.test', 'Registra pagos, emite y concilia comprobantes simulados y canjea puntos.', CAJERO)}
{role('admin', 'Administradores', 'admin.dev@apidental.test', 'Administrador de clínica y de plataforma (un mismo usuario puede tener ambos).', ADMIN)}
<section class="role"><header class="rolehead"><h2>Preguntas frecuentes</h2></header>{faq}
<header class="rolehead" style="margin-top:8mm"><h2>Lo que todavía no está en el panel</h2><p>Funciones del producto que aún no están disponibles, o que se usan por la API.</p></header>{pend}</section>
"""
    return f'<!doctype html><html lang="es"><meta charset="utf-8"><title>Guía de uso de ApiDental</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Manrope:wght@700;800&display=swap"><style>{CSS}</style><body>{body}</body></html>'


if __name__ == '__main__':
    page = build()
    if '--html' in sys.argv:
        pathlib.Path(sys.argv[sys.argv.index('--html') + 1]).write_text(page, encoding='utf-8'); sys.exit()
    browser = next((p for p in (BRAVE, CHROME) if os.path.exists(p)), None)
    if not browser: sys.exit('No se encontró Brave ni Chrome para generar el PDF')
    out = HERE / 'Guia-ApiDental.pdf'
    with tempfile.TemporaryDirectory() as d:
        src = pathlib.Path(d) / 'guia.html'; src.write_text(page, encoding='utf-8')
        subprocess.run([browser, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=20000',
                        f'--print-to-pdf={out}', f'file://{src}'], check=True, capture_output=True, timeout=180)
    pub = ROOT / 'apps/admin/public/guia'; pub.mkdir(parents=True, exist_ok=True); shutil.copy(out, pub / 'Guia-ApiDental.pdf')
    print(out, round(out.stat().st_size / 1e6, 1), 'MB')
