import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFirestore } from './helpers/fake-firestore.js';
import { __setDbForTests } from '../src/lib/firebase.js';
import { app } from '../src/server.js';

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  __setDbForTests(createFakeFirestore({}));
});

test('GET /robots.txt permite indexación en producción y bloquea en hosts de pruebas', async () => {
  const prodRes = await fetch(`${base}/robots.txt`, {
    headers: { 'x-forwarded-host': 'shopuniverses.com', 'x-forwarded-proto': 'https' },
  });
  assert.equal(prodRes.status, 200);
  const prodTxt = await prodRes.text();
  assert.ok(prodTxt.includes('Allow: /'));
  assert.ok(prodTxt.includes('Disallow: /admin'));
  assert.ok(prodTxt.includes('Disallow: /api/'));
  assert.ok(prodTxt.includes('Disallow: /checkout'));
  assert.ok(prodTxt.includes('Sitemap: https://shopuniverses.com/sitemap.xml'));

  const devRes = await fetch(`${base}/robots.txt`, {
    headers: { 'x-forwarded-host': 'develop--shopuniverses.netlify.app', 'x-forwarded-proto': 'https' },
  });
  assert.equal(devRes.status, 200);
  const devTxt = await devRes.text();
  assert.equal(devTxt.trim(), 'User-agent: *\nDisallow: /');
});

test('GET /sitemap.xml devuelve XML válido con rutas públicas y sin rutas privadas', async () => {
  const res = await fetch(`${base}/sitemap.xml`, {
    headers: { 'x-forwarded-host': 'shopuniverses.com', 'x-forwarded-proto': 'https' },
  });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('xml'));
  const xml = await res.text();
  assert.ok(xml.includes('<loc>https://shopuniverses.com/</loc>'));
  assert.ok(xml.includes('<loc>https://shopuniverses.com/catalogo</loc>'));
  assert.ok(xml.includes('<loc>https://shopuniverses.com/spin</loc>'));
  assert.ok(!xml.includes('/admin'));
  assert.ok(!xml.includes('/checkout'));
  assert.ok(!xml.includes('/carrito'));
});

test('Vistas SSR incluyen metadatos SEO, Open Graph, JSON-LD y atribución Startify', async () => {
  const homeRes = await fetch(`${base}/`);
  assert.equal(homeRes.status, 200);
  const html = await homeRes.text();
  assert.ok(html.includes('<meta name="description"'));
  assert.ok(html.includes('<link rel="canonical"'));
  assert.ok(html.includes('property="og:title"'));
  assert.ok(html.includes('application/ld+json'));
  assert.ok(html.includes('https://startify.com.co'));
  assert.ok(html.includes('/assets/img/brand/startify-logo-dark.webp'));

  const logoRes = await fetch(`${base}/assets/img/brand/startify-logo-dark.webp`);
  assert.equal(logoRes.status, 200);

  const checkoutRes = await fetch(`${base}/checkout`);
  const checkoutHtml = await checkoutRes.text();
  assert.ok(checkoutHtml.includes('<meta name="robots" content="noindex, nofollow">'));
});
