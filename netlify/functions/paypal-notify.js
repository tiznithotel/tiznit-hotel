/**
 * DEPRECATED — This endpoint has been retired.
 *
 * It accepted booking data directly from the browser with no PayPal
 * verification, no input validation, and wildcard CORS — allowing any
 * attacker to forge a booking confirmation by sending arbitrary amounts.
 *
 * Replaced by the two-step secure flow:
 *   1. POST /.netlify/functions/create-payment  (server-side order creation)
 *   2. POST /.netlify/functions/verify-payment  (PayPal verification + email)
 */

'use strict';

exports.handler = async () => ({
  statusCode: 410,
  headers: {
    'Content-Type':             'application/json',
    'Cache-Control':            'no-store',
    'Access-Control-Allow-Origin': '',
  },
  body: JSON.stringify({
    error: 'Cet endpoint est désactivé. Utilisez /create-payment et /verify-payment.',
  }),
});
