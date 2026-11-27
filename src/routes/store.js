// ========================================================
// ROUTES/STORE.JS — Vistas públicas renderizadas en servidor (SSR)
// ========================================================
import { Router } from 'express';
import { config } from '../config.js';
import { listCategoriesAsync } from '../lib/catalog.js';
import { getMediaById } from '../lib/images.js';
import { getStoreSettings } from '../lib/promotions.js';
import { DEPARTMENTS, getOrderByCode, reconcileWompiTransaction } from '../lib/orders.js';
import {
  isWompiConfigured,
  buildWompiCheckoutConfig,
  getWompiEnv,
} from '../lib/payments/wompi.js';
import { asyncHandler } from '../lib/http.js';

const router = Router();

function resolvePublicOrigin(req) {
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!host) return config.siteUrl;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/$/, '');
}

const DEFAULT_SEO_DESC =
  'Tienda online en Colombia con productos únicos, importaciones y experiencia de Ruleta Spin. Envíos nacionales y pagos seguros con Wompi.';

const SITEMAP_PATHS = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/catalogo', changefreq: 'daily', priority: '0.9' },
  { path: '/spin', changefreq: 'weekly', priority: '0.8' },
  { path: '/terminos-y-condiciones', changefreq: 'monthly', priority: '0.3' },
  { path: '/politica-de-privacidad', changefreq: 'monthly', priority: '0.3' },
  { path: '/reversion-de-pago', changefreq: 'monthly', priority: '0.3' },
];

// SEO técnico: robots.txt (bloquea indexación en entornos preview/develop)
router.get('/robots.txt', (req, res) => {
  const origin = resolvePublicOrigin(req);
  const isPreviewHost = /(^|\/\/)(develop--|deploy-preview-)/i.test(origin);
  res.type('text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  if (isPreviewHost) {
    return res.send('User-agent: *\nDisallow: /\n');
  }
  return res.send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /api/',
      'Disallow: /checkout',
      'Disallow: /carrito',
      'Disallow: /pedido/',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ].join('\n'),
  );
});

// SEO técnico: sitemap.xml dinámico con rutas públicas indexables
router.get('/sitemap.xml', (req, res) => {
  const origin = resolvePublicOrigin(req);
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_PATHS.map(
    (entry) =>
      `  <url>\n    <loc>${origin}${entry.path}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority}</priority>\n  </url>`,
  ).join('\n');

  res.type('application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
});

// Inyectar ajustes dinámicos, SEO base y evento Flash en todas las vistas públicas
router.use(
  asyncHandler(async (req, res, next) => {
    const settings = await getStoreSettings();
    const origin = resolvePublicOrigin(req);
    const cleanPath = req.path === '/' ? '/' : req.path.replace(/\/+$/, '');
    res.locals.flashSale = settings.flashSale;
    res.locals.storeSettings = settings;
    res.locals.seo = {
      origin,
      canonicalUrl: `${origin}${cleanPath}`,
      description: DEFAULT_SEO_DESC,
      ogImage: `${origin}/assets/img/perfil/2.webp`,
      noindex: false,
    };
    next();
  }),
);

// Redirecciones 301 para URLs .html heredadas
router.get('/index.html', (req, res) => res.redirect(301, '/'));
router.get('/catalogo.html', (req, res) => res.redirect(301, '/catalogo'));
router.get('/spin.html', (req, res) => res.redirect(301, '/spin'));
router.get('/carrito.html', (req, res) => res.redirect(301, '/carrito'));

// Vistas principales
router.get('/', (req, res) => {
  res.render('home', {
    title: null,
    activeNav: 'inicio',
    metaDescription:
      'ShopUniverses: importaciones, productos únicos y ruleta de premios en Colombia. Compra fácil y seguro con Wompi, Nequi, PSE y envíos nacionales.',
  });
});

router.get(
  '/catalogo',
  asyncHandler(async (req, res) => {
    res.render('catalog', {
      title: 'Catálogo',
      activeNav: 'catalogo',
      metaDescription:
        'Explora el catálogo en vivo de ShopUniverses con stock actualizado, descuentos Flash y envíos a toda Colombia.',
      categories: await listCategoriesAsync(),
    });
  }),
);

router.get(
  '/media/:id.webp',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!/^[a-f0-9]{16}$/.test(id)) {
      return res.status(404).end();
    }
    const media = await getMediaById(id);
    if (!media) {
      return res.status(404).end();
    }
    res.set('Content-Type', media.contentType || 'image/webp');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(media.buffer);
  }),
);

router.get('/spin', (req, res) => {
  res.render('spin', {
    title: 'Spin',
    activeNav: 'spin',
    metaDescription:
      'Prueba la Ruleta Spin de ShopUniverses y lleva 5 productos sorpresa seleccionados de nuestro catálogo con reserva garantizada.',
  });
});

router.get('/carrito', (req, res) => {
  res.render('cart', { title: 'Carrito', activeNav: 'carrito', noindex: true });
});

router.get('/terminos-y-condiciones', (req, res) => {
  res.render('legal/terms', {
    title: 'Términos y Condiciones',
    activeNav: '',
    metaDescription: 'Términos y condiciones de compra, envíos, garantía y derecho de retracto en ShopUniverses Colombia.',
  });
});

router.get('/politica-de-privacidad', (req, res) => {
  res.render('legal/privacy', {
    title: 'Política de Privacidad (Habeas Data)',
    activeNav: '',
    metaDescription: 'Política de tratamiento de datos personales de ShopUniverses conforme a la Ley 1581 de 2012 y Ley 2300 de 2023.',
  });
});

router.get('/reversion-de-pago', (req, res) => {
  res.render('legal/reversal', {
    title: 'Reversión de Pago y PQRS',
    activeNav: '',
    metaDescription: 'Radica solicitudes de reversión de pago (Decreto 587/2016), derecho de retracto o PQRS en ShopUniverses.',
  });
});

router.get('/checkout', (req, res) => {
  const wompiEnabled = isWompiConfigured();
  res.render('checkout', {
    title: 'Finalizar compra',
    activeNav: 'carrito',
    noindex: true,
    departments: DEPARTMENTS,
    wompiEnabled,
    isWompiSandbox: wompiEnabled && getWompiEnv() === 'sandbox',
    settings: res.locals.storeSettings,
  });
});

router.get(
  '/pedido/:code',
  asyncHandler(async (req, res, next) => {
    let order = await getOrderByCode(req.params.code);
    if (!order) return next();

    const wompiEnabled = isWompiConfigured();
    const wompiReturnTxId = String(req.query?.id || '').trim();
    if (
      wompiReturnTxId &&
      order.paymentMethod === 'wompi' &&
      order.status === 'pendiente' &&
      wompiEnabled
    ) {
      const reconciled = await reconcileWompiTransaction(order.code, wompiReturnTxId);
      if (reconciled) order = reconciled;
    }

    const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const baseUrl = host ? `${proto}://${host}` : '';

    const wompi =
      order.paymentMethod === 'wompi' && order.status === 'pendiente' && wompiEnabled
        ? buildWompiCheckoutConfig(order, { baseUrl })
        : null;

    res.render('order', {
      title: `Pedido ${order.code}`,
      activeNav: '',
      noindex: true,
      order,
      wompi,
      wompiReturnTxId,
      isWompiSandbox: wompiEnabled && getWompiEnv() === 'sandbox',
      settings: res.locals.storeSettings,
    });
  }),
);

export default router;
