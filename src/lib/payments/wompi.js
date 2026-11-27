// ========================================================
// PAYMENTS/WOMPI.JS — Integración segura con Wompi Bancolombia
// --------------------------------------------------------
// Firma de integridad SHA-256 para checkout, validación
// criptográfica de webhooks (x-event-checksum / signature.checksum)
// y consulta de transacciones contra la API de Wompi.
// ========================================================
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { InventoryError } from '../inventory.js';

const TX_ID_PATTERN = /^[a-zA-Z0-9_-]{4,120}$/;

/** Devuelve el entorno normalizado de Wompi ('sandbox' | 'production'). */
export function getWompiEnv(rawEnv = config.wompi.env) {
  return String(rawEnv || 'sandbox').trim().toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';
}

/** Devuelve la URL base de la API REST de Wompi según el entorno activo. */
export function getWompiApiBaseUrl(rawEnv = config.wompi.env) {
  return getWompiEnv(rawEnv) === 'production'
    ? 'https://production.wompi.co/v1'
    : 'https://sandbox.wompi.co/v1';
}

/** Verifica que el prefijo de la llave pública coincida con WOMPI_ENV. */
export function isWompiEnvConsistent({
  env = config.wompi.env,
  publicKey = config.wompi.publicKey,
} = {}) {
  const key = String(publicKey || '').trim();
  if (!key) return false;
  const normalizedEnv = getWompiEnv(env);
  if (normalizedEnv === 'production') return key.startsWith('pub_prod_');
  return key.startsWith('pub_test_');
}

/** Indica si Wompi cuenta con llaves completas y coherentes con el entorno activo. */
export function isWompiConfigured() {
  const hasSecrets = Boolean(
    config.wompi.publicKey && config.wompi.integritySecret && config.wompi.eventsSecret,
  );
  if (!hasSecrets) return false;

  if (!isWompiEnvConsistent()) {
    console.warn(
      `[wompi] Inconsistencia de entorno: WOMPI_ENV=${getWompiEnv()} no coincide con el prefijo de WOMPI_PUBLIC_KEY.`,
    );
    return false;
  }
  return true;
}

/** Normaliza un número telefónico colombiano para Wompi Web Checkout (+57 + dígitos locales). */
export function normalizeColombianPhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;
  return { prefix: '+57', number: local };
}

/** Firma de integridad SHA-256 requerida por Wompi Web Checkout. */
export function computeWompiIntegritySignature({
  reference,
  amountInCents,
  currency = 'COP',
  expirationTime = '',
  integritySecret = config.wompi.integritySecret,
}) {
  const exp = String(expirationTime || '').trim();
  const raw = exp
    ? `${reference}${amountInCents}${currency}${exp}${integritySecret}`
    : `${reference}${amountInCents}${currency}${integritySecret}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Construye los parámetros y URL segura de redirección a Wompi Web Checkout. */
export function buildWompiCheckoutConfig(order, { baseUrl = '' } = {}) {
  const amountInCents = Math.round(Number(order.total) * 100);
  const currency = 'COP';
  const reference = order.code;
  const parsedExp = order.expiresAt ? new Date(order.expiresAt) : null;
  const expirationTime =
    parsedExp && !Number.isNaN(parsedExp.getTime()) ? parsedExp.toISOString() : '';

  const signatureIntegrity = computeWompiIntegritySignature({
    reference,
    amountInCents,
    currency,
    expirationTime,
  });
  const origin = String(baseUrl || config.siteUrl).replace(/\/$/, '');
  const redirectUrl = `${origin}/pedido/${encodeURIComponent(order.code)}`;

  const params = new URLSearchParams({
    'public-key': config.wompi.publicKey,
    currency,
    'amount-in-cents': String(amountInCents),
    reference,
    'signature:integrity': signatureIntegrity,
    'redirect-url': redirectUrl,
  });

  if (expirationTime) {
    params.set('expiration-time', expirationTime);
  }

  if (order.customer?.email) params.set('customer-data:email', order.customer.email);
  if (order.customer?.name) params.set('customer-data:full-name', order.customer.name);
  const phone = normalizeColombianPhone(order.customer?.phone);
  if (phone) {
    params.set('customer-data:phone-number', phone.number);
    params.set('customer-data:phone-number-prefix', phone.prefix);
  }

  return {
    env: getWompiEnv(),
    publicKey: config.wompi.publicKey,
    currency,
    amountInCents,
    reference,
    expirationTime,
    signatureIntegrity,
    redirectUrl,
    checkoutUrl: `https://checkout.wompi.co/p/?${params.toString()}`,
  };
}

function resolvePropPath(obj, propPath) {
  const parts = String(propPath || '').split('.');
  let cur = obj;
  for (const key of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Verifica la firma SHA-256 y la coherencia de entorno de los eventos Webhook de Wompi. */
export function verifyWompiWebhookSignature(
  payload,
  headerChecksum,
  eventsSecret = config.wompi.eventsSecret,
  expectedEnv = config.wompi.env,
) {
  if (!eventsSecret) {
    throw new InventoryError('Secreto de eventos Wompi no configurado.', 503);
  }

  if (payload?.environment !== undefined && payload?.environment !== null) {
    const incomingEnv = String(payload.environment).trim().toLowerCase();
    const requiredEnv = getWompiEnv(expectedEnv) === 'production' ? 'prod' : 'test';
    if (incomingEnv !== requiredEnv) {
      throw new InventoryError('Entorno de webhook Wompi no coincide con la configuración activa.', 400);
    }
  }

  const props = payload?.signature?.properties;
  const timestamp = payload?.timestamp;
  const checksum = String(headerChecksum || payload?.signature?.checksum || '')
    .trim()
    .toLowerCase();

  if (!Array.isArray(props) || timestamp === undefined || timestamp === null || !checksum) {
    throw new InventoryError('Firma de webhook inválida.', 401);
  }

  let concat = '';
  for (const prop of props) {
    const val = resolvePropPath(payload?.data, prop);
    concat += val === undefined || val === null ? '' : String(val);
  }
  concat += `${timestamp}${eventsSecret}`;

  const expected = crypto.createHash('sha256').update(concat).digest('hex').toLowerCase();
  const a = Buffer.from(checksum, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new InventoryError('Firma de webhook inválida.', 401);
  }

  return true;
}

/** Consulta una transacción en la API de Wompi para reconciliación segura al retorno. */
export async function fetchWompiTransaction(txId, { fetchImpl = globalThis.fetch } = {}) {
  const cleanId = String(txId || '').trim();
  if (!TX_ID_PATTERN.test(cleanId) || typeof fetchImpl !== 'function') {
    return null;
  }

  const url = `${getWompiApiBaseUrl()}/transactions/${encodeURIComponent(cleanId)}`;
  const headers = { Accept: 'application/json' };
  if (config.wompi.privateKey) {
    headers.Authorization = `Bearer ${config.wompi.privateKey}`;
  }

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    return body?.data && typeof body.data === 'object' ? body.data : null;
  } catch (err) {
    console.warn('[wompi] No se pudo consultar la transacción en la API de Wompi:', err?.message || err);
    return null;
  }
}
