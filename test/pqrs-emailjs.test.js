import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createFakeFirestore } from './helpers/fake-firestore.js';
import { __setDbForTests } from '../src/lib/firebase.js';
import { isEmailJsConfigured, sendEmailJs, sendPqrsAutoReply } from '../src/lib/email.js';
import { app } from '../src/server.js';

let server;
let base;
let db;
let prevEmailJs;
let prevAdmin;

before(async () => {
  prevEmailJs = { ...config.emailjs };
  prevAdmin = { email: config.adminEmail, password: config.adminPassword };
  config.adminEmail = 'admin-test@ejemplo.com';
  config.adminPassword = 'ClaveAdminPrueba2026!';

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  Object.assign(config.emailjs, prevEmailJs);
  config.adminEmail = prevAdmin.email;
  config.adminPassword = prevAdmin.password;
  server.close();
});

beforeEach(() => {
  Object.assign(config.emailjs, {
    serviceId: '',
    templateId: '',
    publicKey: '',
    privateKey: '',
  });
  db = createFakeFirestore({});
  __setDbForTests(db);
});

const postForm = (path, params, cookie = '') =>
  fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });

async function loginAsAdmin() {
  const res = await postForm('/admin/login', {
    email: config.adminEmail,
    password: config.adminPassword,
  });
  assert.equal(res.status, 302);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const dash = await fetch(`${base}/admin/pqrs`, { headers: { cookie } });
  assert.equal(dash.status, 200);
  const html = await dash.text();
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  assert.ok(match && match[1]);
  return { cookie, csrf: match[1] };
}

test('Vista /reversion-de-pago expone el formulario PQRS completo', async () => {
  const res = await fetch(`${base}/reversion-de-pago`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const field of [
    'id="pqrs-form"',
    'name="type"',
    'name="orderCode"',
    'name="name"',
    'name="email"',
    'name="phone"',
    'name="document"',
    'name="reason"',
    'name="details"',
    'id="pqrs-accept"',
  ]) {
    assert.ok(html.includes(field), `Falta ${field} en /reversion-de-pago`);
  }
});

test('POST /api/pqrs valida campos obligatorios y rechaza datos inválidos con 400', async () => {
  const cases = [
    { type: 'otro', name: 'Ana', email: 'ana@ejemplo.com', phone: '3001234567', reason: 'Motivo' },
    { type: 'pqrs', name: 'A', email: 'ana@ejemplo.com', phone: '3001234567', reason: 'Motivo' },
    { type: 'pqrs', name: 'Ana Maria', email: 'correo-malo', phone: '3001234567', reason: 'Motivo' },
    { type: 'pqrs', name: 'Ana Maria', email: 'ana@ejemplo.com', phone: '123', reason: 'Motivo' },
    { type: 'pqrs', name: 'Ana Maria', email: 'ana@ejemplo.com', phone: '3001234567', reason: '' },
  ];

  for (const body of cases) {
    const res = await fetch(`${base}/api/pqrs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400);
  }
});

test('POST /api/pqrs radica en Firestore con degradación segura y se gestiona desde /admin/pqrs', async () => {
  assert.equal(isEmailJsConfigured(), false);

  const createRes = await fetch(`${base}/api/pqrs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'retracto',
      orderCode: 'su-99881',
      name: 'Juan Perez',
      email: 'juan@ejemplo.com',
      phone: '3105551234',
      document: '10101010',
      reason: 'Derecho de retracto',
      details: 'Solicitud dentro de los 5 dias habiles.',
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  const radicado = created.claim.radicado;
  assert.ok(radicado.startsWith('PQRS-'));
  assert.equal(created.emailSent, false);

  // Acceso anónimo a /admin/pqrs redirige a login
  const anonRes = await fetch(`${base}/admin/pqrs`, { redirect: 'manual' });
  assert.equal(anonRes.status, 302);
  assert.equal(anonRes.headers.get('location'), '/admin/login');

  // Admin autenticado lista la solicitud y actualiza estado con CSRF
  const { cookie, csrf } = await loginAsAdmin();
  const listRes = await fetch(`${base}/admin/pqrs`, { headers: { cookie } });
  assert.equal(listRes.status, 200);
  const listHtml = await listRes.text();
  assert.ok(listHtml.includes(radicado));
  assert.ok(listHtml.includes('Juan Perez'));

  // Sin CSRF devuelve 403
  const noCsrfRes = await postForm(
    `/admin/pqrs/${radicado}/estado`,
    { status: 'en_proceso', resolutionNote: 'Sin token' },
    cookie,
  );
  assert.equal(noCsrfRes.status, 403);

  // Con CSRF actualiza estado y nota de gestión
  const updRes = await postForm(
    `/admin/pqrs/${radicado}/estado`,
    { _csrf: csrf, status: 'resuelto', resolutionNote: 'Reembolso aprobado' },
    cookie,
  );
  assert.equal(updRes.status, 302);
  const stored = db._data.get(`pqrs/${radicado}`);
  assert.equal(stored.status, 'resuelto');
  assert.equal(stored.resolutionNote, 'Reembolso aprobado');
  assert.ok(stored.updatedAt);

  // Filtro por estado devuelve solo coincidencias
  const filteredRes = await fetch(`${base}/admin/pqrs?estado=resuelto`, { headers: { cookie } });
  const filteredHtml = await filteredRes.text();
  assert.ok(filteredHtml.includes(radicado));
});

test('EmailJS REST API envía plantilla de respuesta automática y maneja errores HTTP', async () => {
  Object.assign(config.emailjs, {
    serviceId: 'service_mock_unit',
    templateId: 'template_mock_unit',
    publicKey: 'pub_key_mock_unit',
    privateKey: 'prv_key_mock_unit',
  });
  assert.equal(isEmailJsConfigured(), true);

  let captured = null;
  const okFetch = async (url, init) => {
    captured = { url, method: init.method, body: JSON.parse(init.body) };
    return { ok: true, status: 200, async text() { return 'OK'; } };
  };

  const okRes = await sendPqrsAutoReply(
    {
      radicado: 'PQRS-54321',
      type: 'reversion',
      orderCode: 'SU-12345',
      name: 'Laura Gomez',
      email: 'laura@ejemplo.com',
      phone: '3001234567',
      document: '10203040',
      reason: 'Producto defectuoso',
      details: 'Caja golpeada',
      createdAt: '2026-11-26T18:00:00.000Z',
    },
    { fetchImpl: okFetch },
  );

  assert.equal(okRes.sent, true);
  assert.equal(captured.url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body.service_id, 'service_mock_unit');
  assert.equal(captured.body.template_id, 'template_mock_unit');
  assert.equal(captured.body.user_id, 'pub_key_mock_unit');
  assert.equal(captured.body.accessToken, 'prv_key_mock_unit');
  assert.equal(captured.body.template_params.to_email, 'laura@ejemplo.com');
  assert.equal(captured.body.template_params.radicado, 'PQRS-54321');

  const failFetch = async () => ({ ok: false, status: 403, async text() { return 'Forbidden'; } });
  const failRes = await sendEmailJs({ templateParams: { to_email: 'a@b.com' }, fetchImpl: failFetch });
  assert.equal(failRes.sent, false);
  assert.equal(failRes.reason, 'http_error');
  assert.equal(failRes.status, 403);
});
