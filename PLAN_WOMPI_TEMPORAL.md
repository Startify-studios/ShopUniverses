# Plan Temporal de Integracion Wompi (Sandbox a Produccion)

Este archivo es temporal y puede eliminarse una vez finalizadas las pruebas y el paso a produccion.

## 1. Objetivo
Activar y validar la pasarela de pagos Wompi Bancolombia en ShopUniverses utilizando primero las llaves gratuitas de pruebas (Sandbox), garantizando:
- Costo cero durante las pruebas (tarjetas, Nequi y PSE simulados).
- Seguridad criptografica (integridad SHA-256, validacion de webhooks, coherencia de ambiente y anti-sobreventa).
- Cero impacto en la logica de negocio existente (inventario transaccional en Firestore, ruleta Spin, Evento Flash, cupones, pagos manuales y WhatsApp).

## 2. Configuracion de Llaves de Prueba (Sandbox)
En el panel de Wompi (Comercio -> Desarrolladores -> Ambiente de Pruebas), obtener:
- `WOMPI_ENV=sandbox`
- `WOMPI_PUBLIC_KEY=pub_test_...`
- `WOMPI_PRIVATE_KEY=prv_test_...`
- `WOMPI_INTEGRITY_SECRET=test_integrity_...`
- `WOMPI_EVENTS_SECRET=test_events_...`

Reglas de seguridad para credenciales:
- Nunca subir llaves ni secretos al repositorio Git (`.env` ya esta en `.gitignore`).
- En Netlify, asignar llaves `test` unicamente en Deploy Previews / Branch Deploys; mantener Production sin cambios hasta completar la validacion.

## 3. Blindaje en Codigo
1. `src/lib/payments/wompi.js`:
   - Validar coherencia entre `WOMPI_ENV` y el prefijo de `WOMPI_PUBLIC_KEY` (`pub_test_` en sandbox, `pub_prod_` en production) y exigir `WOMPI_EVENTS_SECRET`.
   - Incluir `expiration-time` sincronizado con `order.expiresAt` en la URL de Web Checkout y en la firma de integridad SHA-256.
   - Normalizar `customer-data:phone-number` y agregar `customer-data:phone-number-prefix=+57`.
   - Validar `payload.environment` (`test` / `prod`) en `verifyWompiWebhookSignature`.
   - Agregar `fetchWompiTransaction(txId)` contra `sandbox.wompi.co/v1` o `production.wompi.co/v1`.
2. `src/lib/orders.js`:
   - Guardar `paymentEnv` en ordenes Wompi para trazabilidad en Firestore.
   - Validar `currency === 'COP'` en webhook y reconciliacion.
   - Impedir que un webhook tardio (`DECLINED`/`VOIDED`/`ERROR`) cancele una orden ya pagada, enviada o entregada.
   - Exponer `reconcileWompiTransaction(orderCode, txId)` idempotente.
3. `src/routes/api.js` y `src/routes/store.js`:
   - Excluir `POST /api/payments/wompi/webhook` del `apiLimiter` de usuarios finales.
   - Reconciliar automaticamente en `GET /pedido/:code?id=<txId>` cuando el cliente retorna desde Wompi.
   - Mostrar aviso discreto de modo pruebas en checkout y pedido solo cuando `WOMPI_ENV === 'sandbox'`.
4. `test/checkout-wompi.test.js`:
   - Cubrir todos los nuevos casos de seguridad, ambiente, expiracion, moneda, transiciones protegidas y reconciliacion.

## 4. Matriz de Pruebas en Sandbox
Configurar en Wompi (Ambiente de Pruebas -> URL de eventos):
`https://<dominio-o-deploy-preview>/api/payments/wompi/webhook`

Casos a verificar:
1. Pago aprobado (`APPROVED`): orden pasa a `pagado`, guarda `paymentRef`, confirma reserva de stock y mantiene consumo del cupon.
2. Pago rechazado (`DECLINED`): orden pasa a `cancelado`, stock regresa a Firestore y se restituye el uso del cupon.
3. Retorno inmediato (`/pedido/:code?id=...`): estado actualizado al instante sin inducir doble pago.
4. Alteracion de monto en URL de checkout: Wompi rechaza por firma de integridad.
5. Webhook con `x-event-checksum` alterado o entorno cruzado: API responde 401/400 sin modificar la orden.
6. Idempotencia: reenviar el mismo webhook `APPROVED` dos veces mantiene el estado y el stock intactos.
7. Regresion de negocio: Evento Flash, cupones, ruleta Spin, transferencia manual y WhatsApp operan sin cambios.

## 5. Paso a Produccion
1. Configurar `WOMPI_ENV=production` y las llaves `prod_` en el contexto Production de Netlify.
2. Configurar la URL de eventos de produccion en Wompi: `https://<dominio-produccion>/api/payments/wompi/webhook`.
3. Ejecutar una compra real controlada de monto bajo y verificar el ciclo completo (`pendiente -> pagado -> enviado`).
