/* Landing pública: lee servicios y horarios de /v1/public/booking y envía una SOLICITUD de cita (no una reserva).
   Con ?mock=1 usa datos de ejemplo en memoria y simula el envío, para ver toda la interfaz sin la API. */
(function () {
  'use strict';

  var API = '/v1/public/booking';
  var MOCK = /[?&]mock=1\b/.test(location.search);
  var TZ = 'America/Lima';
  var DAYS_AHEAD = 14;

  var $ = function (id) { return document.getElementById(id); };
  var state = { info: null, days: [], date: '', time: '', loadingSlots: 0 };

  // ------------------------------------------------------------------ utilidades
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  function limaToday() { return ymd.format(new Date()); }
  function addDays(date, n) {
    var d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dayParts(date) {
    var d = new Date(date + 'T12:00:00-05:00');
    return {
      weekday: new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'short' }).format(d).replace('.', ''),
      day: new Intl.DateTimeFormat('es-PE', { timeZone: TZ, day: 'numeric' }).format(d),
      month: new Intl.DateTimeFormat('es-PE', { timeZone: TZ, month: 'short' }).format(d).replace('.', ''),
      long: new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d),
    };
  }
  function duration(min) {
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + ' h ' + m + ' min' : h + ' h';
  }
  function say(msg, kind) {
    var s = $('form-status');
    s.textContent = msg || '';
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------------ acceso a la API
  function http(method, path, body) {
    if (MOCK) return mockHttp(method, path, body);
    var opt = { method: method, headers: { Accept: 'application/json' } };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-Requested-With'] = 'ApiDental'; opt.body = JSON.stringify(body); }
    return fetch(API + path, opt).then(function (res) {
      return res.text().then(function (t) {
        var json = null;
        try { json = t ? JSON.parse(t) : null; } catch (e) { json = null; }
        if (!res.ok) { var err = new Error('http'); err.status = res.status; err.body = json; throw err; }
        return json;
      });
    }, function () { var err = new Error('network'); err.status = 0; throw err; });
  }

  // ------------------------------------------------------------------ modo demostración
  function mockHttp(method, path, body) {
    return new Promise(function (resolve, reject) {
      var q = path.split('?');
      var route = q[0];
      var params = new URLSearchParams(q[1] || '');
      setTimeout(function () {
        if (method === 'GET' && route === '/info') {
          return resolve({
            clinic: { name: 'Clínica Demo' },
            branches: [{ id: 'b1', name: 'Sede Central', address: 'Dirección de ejemplo 123' }, { id: 'b2', name: 'Sede Norte', address: null }],
            services: [
              { id: 's1', name: 'Consulta de evaluación', durationMinutes: 30, priceText: 'S/ 60.00' },
              { id: 's2', name: 'Limpieza dental', durationMinutes: 45, priceText: 'S/ 80.00' },
              { id: 's3', name: 'Restauración dental', durationMinutes: 60, priceText: 'S/ 150.00' },
              { id: 's4', name: 'Control de ortodoncia', durationMinutes: 30, priceText: null },
              { id: 's5', name: 'Extracción simple', durationMinutes: 45, priceText: 'S/ 120.00' },
            ],
          });
        }
        if (method === 'GET' && route === '/availability') {
          var from = params.get('from'), to = params.get('to') || from, days = [];
          for (var d = from, i = 0; d <= to && i < 31; d = addDays(d, 1), i++) {
            var wd = new Date(d + 'T12:00:00Z').getUTCDay();
            if (wd === 0 || (wd + parseInt(d.slice(-2), 10)) % 5 === 0) continue; // sin domingos ni algunos días
            var times = [];
            for (var h = 9; h < 18; h++) { if (h === 13) continue; times.push(('0' + h).slice(-2) + ':00'); if ((h + wd) % 2) times.push(('0' + h).slice(-2) + ':30'); }
            if (d === limaToday()) times = times.filter(function (t) { return t > '17:00'; });
            if (times.length) days.push({ date: d, times: times });
          }
          return resolve({ durationMinutes: 30, days: days });
        }
        if (method === 'POST' && route === '/requests') {
          if (/conflicto/i.test(body.notes || '')) return reject({ status: 409, body: { code: 'SLOT_UNAVAILABLE' } }); // para probar el aviso
          return resolve({ reference: 'SOL-' + Math.random().toString(36).slice(2, 8).toUpperCase() });
        }
        reject({ status: 404 });
      }, route === '/requests' ? 800 : 250);
    });
  }

  // ------------------------------------------------------------------ carga de la clínica
  function renderInfo(info) {
    state.info = info;
    var name = (info.clinic && info.clinic.name) || 'Clínica';
    $('clinic-name').textContent = name;
    document.title = name + ' — Solicite su cita';
    var og = document.querySelector('meta[property="og:title"]');
    if (og) og.setAttribute('content', document.title);

    var list = $('services');
    list.textContent = '';
    list.removeAttribute('aria-busy');
    if (!info.services.length) {
      list.appendChild(el('li', { class: 'card' }, [el('p', { text: 'Pronto publicaremos nuestros servicios.' })]));
    }
    info.services.forEach(function (s) {
      var meta = el('div', { class: 'meta' }, [el('span', { class: 'pill', text: duration(s.durationMinutes) })]);
      if (s.priceText) meta.appendChild(el('span', { class: 'pill price', text: 'Referencial ' + s.priceText }));
      var pick = el('a', { class: 'pick', href: '#solicitar', 'data-service': s.id, text: 'Solicitar este servicio' });
      list.appendChild(el('li', { class: 'card' }, [el('h3', { text: s.name }), meta, pick]));
    });

    var branches = $('branches');
    branches.textContent = '';
    info.branches.forEach(function (b) {
      var li = el('li', { class: 'branch' }, [el('h3', { text: b.name })]);
      li.appendChild(el('p', { text: b.address || 'Consulte la dirección al confirmar su cita.' }));
      branches.appendChild(li);
    });
    if (!info.branches.length) $('sedes').hidden = true;

    var bsel = $('branch');
    bsel.textContent = '';
    info.branches.forEach(function (b) { bsel.appendChild(el('option', { value: b.id, text: b.name })); });
    $('branch-field').hidden = info.branches.length < 2;

    var ssel = $('service');
    ssel.textContent = '';
    ssel.appendChild(el('option', { value: '', text: 'Seleccione un servicio…' }));
    info.services.forEach(function (s) { ssel.appendChild(el('option', { value: s.id, text: s.name + ' · ' + duration(s.durationMinutes) + (s.priceText ? ' · ' + s.priceText : '') })); });
  }

  function loadInfo() {
    if (MOCK) $('demo-banner').hidden = false;
    return http('GET', '/info').then(renderInfo, function (err) {
      var list = $('services');
      list.textContent = '';
      list.removeAttribute('aria-busy');
      var msg = err.status === 404
        ? 'La solicitud de citas en línea no está disponible por ahora. Comuníquese directamente con la clínica.'
        : 'No pudimos cargar los servicios. Revise su conexión e intente de nuevo.';
      var box = $('services-error');
      box.textContent = msg;
      box.hidden = false;
      $('booking').hidden = true;
      $('f-when').disabled = true;
      var p = el('p', { class: 'notice', text: msg });
      $('booking').parentNode.insertBefore(p, $('booking'));
    });
  }

  // ------------------------------------------------------------------ horarios
  function clearWhen(hint) {
    state.days = []; state.date = ''; state.time = '';
    $('when-body').hidden = true;
    $('days').textContent = ''; $('times').textContent = '';
    $('when-hint').textContent = hint || 'Elija primero un servicio para ver los horarios.';
    $('when-hint').hidden = false;
    $('when-err').textContent = '';
  }

  function loadSlots(keepSelection) {
    var serviceId = $('service').value;
    if (!serviceId) { $('f-when').disabled = true; clearWhen(); $('service-help').textContent = ''; return; }
    var svc = state.info.services.filter(function (s) { return s.id === serviceId; })[0];
    $('service-help').textContent = svc ? 'Duración aproximada: ' + duration(svc.durationMinutes) + '.' : '';
    $('f-when').disabled = false;
    var prev = keepSelection ? { date: state.date, time: state.time } : null;
    clearWhen('Buscando horarios disponibles…');
    var ticket = ++state.loadingSlots;
    var from = limaToday();
    var qs = '?branchId=' + encodeURIComponent($('branch').value) + '&serviceId=' + encodeURIComponent(serviceId) + '&from=' + from + '&to=' + addDays(from, DAYS_AHEAD - 1);
    http('GET', '/availability' + qs).then(function (res) {
      if (ticket !== state.loadingSlots) return;
      state.days = (res.days || []).filter(function (d) { return d.times && d.times.length; });
      if (!state.days.length) { clearWhen('No hay horarios en los próximos días; llámenos o intente con otro servicio.'); return; }
      $('when-hint').hidden = true;
      $('when-body').hidden = false;
      renderDays();
      if (prev && prev.date) {
        var d = state.days.filter(function (x) { return x.date === prev.date; })[0];
        if (d) { selectDay(prev.date); if (d.times.indexOf(prev.time) >= 0) selectTime(prev.time); }
      }
    }, function (err) {
      if (ticket !== state.loadingSlots) return;
      clearWhen(err.status === 429
        ? 'Hay muchas consultas desde su conexión. Espere un momento y vuelva a elegir el servicio.'
        : 'No pudimos consultar los horarios. Revise su conexión y vuelva a elegir el servicio.');
    });
  }

  function chip(name, value, labelNodes, checked) {
    var id = name + '-' + value.replace(/[^\w-]/g, '');
    var input = el('input', { type: 'radio', name: name, id: id, value: value });
    if (checked) input.checked = true;
    var label = el('label', { class: 'chip', for: id }, [input, el('span', {}, labelNodes)]);
    return label;
  }

  function renderDays() {
    var box = $('days');
    box.textContent = '';
    state.days.forEach(function (d) {
      var p = dayParts(d.date);
      var lab = chip('day', d.date, [p.day + ' ' + p.month, el('small', { text: p.weekday })], d.date === state.date);
      lab.querySelector('input').setAttribute('aria-label', p.long);
      lab.querySelector('input').addEventListener('change', function () { selectDay(d.date); });
      box.appendChild(lab);
    });
  }

  function selectDay(date) {
    state.date = date; state.time = '';
    var d = state.days.filter(function (x) { return x.date === date; })[0];
    var input = document.querySelector('input[name="day"][value="' + date + '"]');
    if (input) input.checked = true;
    var box = $('times');
    box.textContent = '';
    (d ? d.times : []).forEach(function (t) {
      var lab = chip('time', t, [t], false);
      lab.querySelector('input').addEventListener('change', function () { state.time = t; $('when-err').textContent = ''; });
      box.appendChild(lab);
    });
    $('when-err').textContent = '';
  }
  function selectTime(t) {
    state.time = t;
    var input = document.querySelector('input[name="time"][value="' + t + '"]');
    if (input) input.checked = true;
  }

  // ------------------------------------------------------------------ validación y envío
  var DOC = {
    DNI: { re: /^\d{8}$/, msg: 'El DNI tiene 8 dígitos.' },
    CE: { re: /^[A-Za-z0-9]{6,20}$/, msg: 'El carné de extranjería tiene entre 6 y 20 letras o números.' },
    PASSPORT: { re: /^[A-Za-z0-9]{6,20}$/, msg: 'El pasaporte tiene entre 6 y 20 letras o números.' },
  };
  var FIELD_ORDER = ['service', 'when', 'firstName', 'lastName', 'mobile', 'documentNumber', 'email', 'acceptPrivacy'];

  function values() {
    return {
      branchId: $('branch').value,
      serviceId: $('service').value,
      firstName: $('firstName').value.trim(),
      lastName: $('lastName').value.trim(),
      secondLastName: $('secondLastName').value.trim(),
      mobile: $('mobile').value.replace(/\s/g, ''),
      documentType: $('documentType').value,
      documentNumber: $('documentNumber').value.trim(),
      email: $('email').value.trim(),
      notes: $('notes').value.trim(),
      acceptPrivacy: $('acceptPrivacy').checked,
    };
  }

  function validate(v) {
    var e = {};
    if (!v.serviceId) e.service = 'Elija un servicio.';
    if (!state.date || !state.time) e.when = 'Elija un día y una hora.';
    if (!v.firstName) e.firstName = 'Escriba sus nombres.';
    if (!v.lastName) e.lastName = 'Escriba su apellido paterno.';
    if (!/^9\d{8}$/.test(v.mobile)) e.mobile = 'Escriba un celular de 9 dígitos que empiece con 9.';
    if (v.documentNumber && !DOC[v.documentType].re.test(v.documentNumber)) e.documentNumber = DOC[v.documentType].msg;
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) e.email = 'Escriba un correo válido.';
    if (!v.acceptPrivacy) e.acceptPrivacy = 'Debe aceptar el aviso de privacidad para enviar la solicitud.';
    return e;
  }

  function showErrors(errors) {
    FIELD_ORDER.forEach(function (k) {
      var box = $(k === 'when' ? 'when-err' : k === 'service' ? 'service-err' : k + '-err');
      if (box) box.textContent = errors[k] || '';
      var input = $(k);
      if (input && input.tagName !== 'DIV') { if (errors[k]) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
    });
    var first = FIELD_ORDER.filter(function (k) { return errors[k]; })[0];
    if (!first) return;
    var target = first === 'when' ? (document.querySelector('input[name="day"]') || $('service')) : $(first);
    if (target) target.focus();
  }

  function submit(ev) {
    ev.preventDefault();
    var v = values();
    var errors = validate(v);
    showErrors(errors);
    if (Object.keys(errors).length) { say('Revise los campos marcados.', 'error'); return; }
    // El campo señuelo lo llenan los robots; se envía tal cual para que la API lo descarte.
    var body = {
      branchId: v.branchId, serviceId: v.serviceId, date: state.date, time: state.time,
      firstName: v.firstName, lastName: v.lastName, mobile: v.mobile, acceptPrivacy: true,
      website: $('website').value,
    };
    if (v.secondLastName) body.secondLastName = v.secondLastName;
    if (v.documentNumber) { body.documentType = v.documentType; body.documentNumber = v.documentNumber; }
    if (v.email) body.email = v.email;
    if (v.notes) body.notes = v.notes;

    var btn = $('submit');
    btn.disabled = true; btn.textContent = 'Enviando…';
    say('Enviando su solicitud…');
    http('POST', '/requests', body).then(function (res) {
      $('reference').textContent = (res && res.reference) || '';
      $('booking').hidden = true;
      var ok = $('success');
      ok.hidden = false;
      ok.focus();
      ok.scrollIntoView({ block: 'center' });
      say('');
    }, function (err) {
      var msg;
      if (err.status === 409 && err.body && err.body.code === 'SLOT_UNAVAILABLE') {
        msg = 'Ese horario ya no está disponible. Actualizamos los horarios libres: elija otro. Sus datos siguen aquí.';
        loadSlots(false);
        say(msg, 'warn');
      } else if (err.status === 429) {
        say('Recibimos muchas solicitudes desde su conexión. Espere unos minutos e intente de nuevo.', 'error');
      } else if (err.status === 400) {
        var m = err.body && err.body.message;
        say('Revise los datos: ' + (Array.isArray(m) ? m.join(' ') : (m || 'alguno no es válido.')), 'error');
      } else if (err.status === 0) {
        say('No pudimos conectar con la clínica. Revise su conexión e intente de nuevo; sus datos siguen aquí.', 'error');
      } else {
        say('No pudimos enviar su solicitud. Intente de nuevo en unos minutos.', 'error');
      }
    }).then(function () { btn.disabled = false; btn.textContent = 'Enviar solicitud'; });
  }

  function reset() {
    $('booking').reset();
    clearWhen();
    $('f-when').disabled = true;
    $('service-help').textContent = '';
    showErrors({});
    say('');
    $('success').hidden = true;
    $('booking').hidden = false;
    $('service').focus();
  }

  // ------------------------------------------------------------------ inicio
  document.addEventListener('DOMContentLoaded', function () {
    $('service').addEventListener('change', function () { loadSlots(false); });
    $('branch').addEventListener('change', function () { loadSlots(false); });
    // Al corregir un campo, su aviso de error desaparece.
    FIELD_ORDER.forEach(function (k) {
      var input = $(k), box = $(k === 'when' ? 'when-err' : k === 'service' ? 'service-err' : k + '-err');
      if (!input || !box || input.tagName === 'DIV') return;
      var clear = function () { box.textContent = ''; input.removeAttribute('aria-invalid'); };
      input.addEventListener('input', clear);
      input.addEventListener('change', clear);
    });
    $('booking').addEventListener('submit', submit);
    $('another').addEventListener('click', reset);
    $('mobile').addEventListener('input', function () { this.value = this.value.replace(/[^\d\s]/g, ''); });
    $('documentType').addEventListener('change', function () {
      var dni = this.value === 'DNI';
      $('documentNumber').setAttribute('inputmode', dni ? 'numeric' : 'text');
      $('documentNumber').setAttribute('maxlength', dni ? '8' : '20');
      $('documentNumber').value = '';
    });
    $('documentNumber').addEventListener('input', function () { if ($('documentType').value === 'DNI') this.value = this.value.replace(/\D/g, ''); });
    $('services').addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-service]') : null;
      if (!a) return;
      var sel = $('service');
      sel.value = a.getAttribute('data-service');
      loadSlots(false);
    });
    $('documentNumber').setAttribute('maxlength', '8');
    loadInfo();
  });
})();
