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

before(async () => {
  prevEmailJs = { ...config.emailjs };
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  Object.assign(config.emailjs, prevEmailJs);
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

test('Vista /reversion-de-pago expone el formulario PQRS completo con los campos esperados', async () => {
  const res = await fetch(`${base}/reversion-de-pago`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const field of ['id="pqrs-form"', 'name="type"', 'name="orderCode"', 'name="name"', 'name="email"', 'name="phone"', 'name="document"', 'name="reason"', 'name="details"', 'id="pqrs-accept"']) {
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

test('POST /api/pqrs radica en Firestore incluso si EmailJS no está configurado (degradación segura)', async () => {
  assert.equal(isEmailJsConfigured(), false);

  const res = await fetch(`${base}/api/pqrs`, {
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
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.claim.radicado.startsWith('PQRS-'));
  assert.equal(body.claim.orderCode, 'SU-99881');
  assert.equal(body.emailSent, false);
  assert.equal(db._data.get(`pqrs/${body.claim.radicado}`)?.status, 'radicado');
});

test('EmailJS REST API envía plantilla Auto-Reply (service_hdoy6a8 / template_dqeddjr) y maneja errores HTTP', async () => {
  Object.assign(config.emailjs, {
    serviceId: 'service_hdoy6a8',
    templateId: 'template_dqeddjr',
    publicKey: 'pub_key_test',
    privateKey: 'prv_key_test',
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
  assert.equal(captured.body.service_id, 'service_hdoy6a8');
  assert.equal(captured.body.template_id, 'template_dqeddjr');
  assert.equal(captured.body.user_id, 'pub_key_test');
  assert.equal(captured.body.accessToken, 'prv_key_test');
  assert.equal(captured.body.template_params.to_email, 'laura@ejemplo.com');
  assert.equal(captured.body.template_params.radicado, 'PQRS-54321');

  const failFetch = async () => ({ ok: false, status: 403, async text() { return 'Forbidden'; } });
  const failRes = await sendEmailJs({ templateParams: { to_email: 'a@b.com' }, fetchImpl: failFetch });
  assert.equal(failRes.sent, false);
  assert.equal(failRes.reason, 'http_error');
  assert.equal(failRes.status, 403);
});
