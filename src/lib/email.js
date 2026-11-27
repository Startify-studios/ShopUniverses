// ========================================================
// EMAIL.JS — Integración segura con EmailJS desde servidor
// --------------------------------------------------------
// Envía correos mediante la API REST de EmailJS sin exponer
// llaves en el navegador ni abrir directivas CSP.
// ========================================================
import { config } from '../config.js';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

/** Indica si EmailJS tiene configuradas las credenciales mínimas en servidor. */
export function isEmailJsConfigured(cfg = config.emailjs) {
  return Boolean(cfg?.serviceId && cfg?.templateId && cfg?.publicKey && cfg?.privateKey);
}

/** Envía una plantilla de EmailJS usando la API REST oficial. */
export async function sendEmailJs({
  serviceId = config.emailjs.serviceId,
  templateId = config.emailjs.templateId,
  publicKey = config.emailjs.publicKey,
  privateKey = config.emailjs.privateKey,
  templateParams = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!serviceId || !templateId || !publicKey || !privateKey) {
    return { sent: false, reason: 'not_configured' };
  }
  if (typeof fetchImpl !== 'function') {
    return { sent: false, reason: 'fetch_unavailable' };
  }

  const payload = {
    service_id: serviceId,
    template_id: templateId,
    user_id: publicKey,
    accessToken: privateKey,
    template_params: templateParams,
  };

  try {
    const res = await fetchImpl(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
    });

    if (!res || !res.ok) {
      const detail = res ? await res.text().catch(() => '') : '';
      console.warn(`[emailjs] Error HTTP ${res?.status || 'sin_respuesta'}: ${detail}`);
      return { sent: false, reason: 'http_error', status: res?.status || 0 };
    }

    return { sent: true };
  } catch (err) {
    console.warn('[emailjs] Fallo de red enviando correo:', err?.message || err);
    return { sent: false, reason: 'network_error' };
  }
}

const PQRS_TYPE_LABELS = {
  reversion: 'Reversión de pago (Decreto 587/2016)',
  retracto: 'Derecho de retracto (Ley 2439/2024)',
  pqrs: 'Consulta / Reclamo / Habeas Data (PQRS)',
};

/** Envía correo automático de radicación PQRS al cliente con copia al comercio. */
export async function sendPqrsAutoReply(claim, { fetchImpl } = {}) {
  if (!claim || !claim.email) {
    return { sent: false, reason: 'invalid_claim' };
  }

  const typeLabel = PQRS_TYPE_LABELS[claim.type] || claim.type;
  const templateParams = {
    to_email: claim.email,
    reply_to: config.store.email,
    store_name: config.store.name,
    store_email: config.store.email,
    radicado: claim.radicado,
    type: typeLabel,
    order_code: claim.orderCode || 'No especificado',
    name: claim.name,
    email: claim.email,
    phone: claim.phone,
    document: claim.document || 'No especificado',
    reason: claim.reason,
    details: claim.details || 'Sin detalles adicionales',
    created_at: claim.createdAt,
    message: `Radicado ${claim.radicado} (${typeLabel}). Motivo: ${claim.reason}. ${claim.details || ''}`.trim(),
  };

  return sendEmailJs({ templateParams, fetchImpl });
}
