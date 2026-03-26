/**
 * POST /.netlify/functions/verify-payment
 *
 * Called by the browser after PayPal's onApprove fires.
 * 1. Re-validates all booking inputs server-side.
 * 2. Fetches the PayPal order server-to-server and asserts:
 *    - status === 'COMPLETED' (payment actually captured)
 *    - captured EUR amount === server-computed expected amount (±2¢ tolerance)
 * 3. Generates a cryptographically-random reservation number.
 * 4. Sends confirmation email via Resend.
 * 5. Returns booking details to the client (stored in sessionStorage, NOT URL).
 *
 * Any price mismatch is logged and rejected — no email is sent.
 */

'use strict';

const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));
const crypto = require('crypto');

// ─── Authoritative price catalog (must match create-payment.js) ──────────────
const ROOM_CATALOG = {
  single: { name: 'Chambre Single', priceMAD: 247, maxGuests: 2 },
  double: { name: 'Chambre Double', priceMAD: 310, maxGuests: 3 },
  triple: { name: 'Chambre Triple', priceMAD: 438, maxGuests: 4 },
};
const BREAKFAST = 36;
const TAX       = 10;
const MAD_TO_EUR         = 0.093;
const AMOUNT_TOLERANCE   = 0.02; // 2-cent rounding tolerance
const MAX_STAY_NIGHTS    = 90;

// ─── Price engine (must match create-payment.js exactly) ─────────────────────
function computeExpectedEUR(room, checkIn, checkOut, guests) {
  const r      = ROOM_CATALOG[room];
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const g      = parseInt(guests, 10);
  let   total  = r.priceMAD * nights + BREAKFAST * g * nights + TAX * g * nights;
  if (nights > 5) total = Math.round(total * 0.8);
  return parseFloat((total * MAD_TO_EUR).toFixed(2));
}

function computeTotalMAD(room, checkIn, checkOut, guests) {
  const r      = ROOM_CATALOG[room];
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const g      = parseInt(guests, 10);
  let   total  = r.priceMAD * nights + BREAKFAST * g * nights + TAX * g * nights;
  if (nights > 5) total = Math.round(total * 0.8);
  return total;
}

// ─── Input validation ─────────────────────────────────────────────────────────
function validateInput({ orderID, room, checkIn, checkOut, guests, name, email }) {
  const errors = [];

  // orderID: PayPal order IDs are uppercase alphanumeric, 17 chars
  if (!orderID || typeof orderID !== 'string' || !/^[A-Z0-9]{17}$/.test(orderID)) {
    errors.push('Order ID PayPal invalide.');
  }

  if (!room || !ROOM_CATALOG[room]) {
    errors.push('Type de chambre invalide.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) errors.push("Date d'arrivée invalide.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) errors.push('Date de départ invalide.');

  if (errors.length === 0) {
    const ci     = new Date(checkIn);
    const co     = new Date(checkOut);
    const nights = Math.round((co - ci) / 86400000);
    if (co <= ci)               errors.push("La date de départ doit être après l'arrivée.");
    if (nights > MAX_STAY_NIGHTS) errors.push(`Séjour maximum : ${MAX_STAY_NIGHTS} nuits.`);
  }

  const g = parseInt(guests, 10);
  if (!Number.isInteger(g) || g < 1 || g > 4) {
    errors.push('Nombre de voyageurs invalide (1–4).');
  } else if (room && ROOM_CATALOG[room] && g > ROOM_CATALOG[room].maxGuests) {
    errors.push(`Capacité maximale : ${ROOM_CATALOG[room].maxGuests} personnes.`);
  }

  // Name: optional, but if provided must be reasonable
  if (name && (typeof name !== 'string' || name.length > 120)) {
    errors.push('Nom invalide.');
  }

  // Email: optional, but if provided must be valid
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) {
    errors.push('Adresse email invalide.');
  }

  return errors;
}

// ─── Sanitize user text for safe HTML email embedding ────────────────────────
function esc(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str
    .substring(0, maxLen)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ─── PayPal server-to-server helpers ─────────────────────────────────────────
async function getPayPalAccessToken() {
  const base        = process.env.PAYPAL_BASE_URL || 'https://api-m.paypal.com';
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString('base64');

  const res = await fetch(`${base}/v1/oauth2/token`, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) throw new Error('PayPal authentication failed.');
  const data = await res.json();
  return data.access_token;
}

async function fetchPayPalOrder(orderID, token) {
  const base = process.env.PAYPAL_BASE_URL || 'https://api-m.paypal.com';
  const res  = await fetch(`${base}/v2/checkout/orders/${orderID}`, {
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    console.error(`PayPal order fetch failed for ${orderID}: ${res.status}`);
    throw new Error('Impossible de vérifier le paiement PayPal.');
  }

  return res.json();
}

// ─── Email notification ───────────────────────────────────────────────────────
async function sendConfirmationEmail({
  resNb, name, email, room, checkIn, checkOut,
  guests, nights, totalMAD, totalEUR, paypalId,
}) {
  // All values are HTML-escaped before insertion
  const html = `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e8dcc8;padding:32px">
  <h2 style="color:#1c1812;font-size:22px;margin-bottom:4px">&#x2705; Paiement PayPal confirm&#xe9;</h2>
  <p style="color:#c9a96e;font-size:13px;margin-bottom:24px">
    N&#xb0;&nbsp;de r&#xe9;servation&nbsp;: <strong>${esc(resNb)}</strong>
  </p>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Nom</td>
        <td style="padding:8px 0;font-weight:bold;font-size:14px">${esc(name)}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Email</td>
        <td style="padding:8px 0;font-size:14px">${email ? esc(email) : '&mdash;'}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Chambre</td>
        <td style="padding:8px 0;font-weight:bold;font-size:14px">${esc(room)}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Arriv&#xe9;e</td>
        <td style="padding:8px 0;font-size:14px">${esc(checkIn)}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">D&#xe9;part</td>
        <td style="padding:8px 0;font-size:14px">${esc(checkOut)}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Voyageurs</td>
        <td style="padding:8px 0;font-size:14px">${esc(String(guests))}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Nuits</td>
        <td style="padding:8px 0;font-size:14px">${esc(String(nights))}</td></tr>
    <tr style="border-top:2px solid #c9a96e">
      <td style="padding:12px 0;font-weight:bold;font-size:16px">Total pay&#xe9;</td>
      <td style="padding:12px 0;font-weight:bold;font-size:16px;color:#c9a96e">
        ${esc(String(totalMAD))}&nbsp;DHS (${esc(String(totalEUR))}&nbsp;&#x20ac;)
      </td>
    </tr>
  </table>
  <p style="margin-top:20px;padding:12px;background:#f0f7f0;border-left:3px solid #2ecc71;font-size:13px;color:#1c1812">
    &#x1F4B3; R&#xe9;f&#xe9;rence PayPal&nbsp;: <strong>${esc(paypalId)}</strong>
  </p>
  <p style="margin-top:16px;font-size:11px;color:#b5a898">
    &#x26A0;&#xFE0F; Ce message a &#xe9;t&#xe9; g&#xe9;n&#xe9;r&#xe9; automatiquement apr&#xe8;s v&#xe9;rification
    serveur du paiement PayPal.
  </p>
</div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'Tiznit Hotel <onboarding@resend.dev>',
      to:      [process.env.NOTIFY_EMAIL],
      subject: `✅ Réservation ${esc(resNb)} — ${esc(room)}`,
      html,
    }),
  });

  if (!res.ok) {
    // Email failure must NOT block the booking confirmation
    const err = await res.json().catch(() => ({}));
    console.error('Email send failed:', JSON.stringify(err));
  }
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const rlStore = new Map();

function isRateLimited(ip) {
  const now    = Date.now();
  const window = 60_000;
  const limit  = 5;
  const entry  = rlStore.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > window) { entry.count = 1; entry.windowStart = now; }
  else                                  { entry.count++; }
  rlStore.set(ip, entry);
  return entry.count > limit;
}

// ─── CORS helper ─────────────────────────────────────────────────────────────
function corsHeaders(event) {
  const allowed  = process.env.ALLOWED_ORIGIN || '';
  const origin   = event.headers['origin'] || '';
  const isAllowed =
    (allowed && origin === allowed) ||
    /^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin);
  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : '',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control':                'no-store',
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const clientIP =
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  if (isRateLimited(clientIP)) {
    console.warn(`Rate limit hit on verify-payment: ${clientIP}`);
    return {
      statusCode: 429,
      headers: { ...headers, 'Retry-After': '60' },
      body: JSON.stringify({ error: 'Trop de requêtes. Veuillez patienter 1 minute.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Corps de requête invalide.' }) };
  }

  const { orderID, name, email, room, checkIn, checkOut, guests } = body;

  // Server-side validation
  const errors = validateInput({ orderID, room, checkIn, checkOut, guests, name, email });
  if (errors.length > 0) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ error: 'Données invalides.', details: errors }),
    };
  }

  try {
    // ── 1. Verify payment with PayPal API (server-to-server) ──────────────
    const token = await getPayPalAccessToken();
    const order = await fetchPayPalOrder(orderID, token);

    // ── 2. Assert the order is fully captured ─────────────────────────────
    if (order.status !== 'COMPLETED') {
      console.warn(`Payment not COMPLETED. status=${order.status} orderID=${orderID} IP=${clientIP}`);
      return {
        statusCode: 402,
        headers,
        body: JSON.stringify({
          error: `Paiement non confirmé (statut : ${order.status}). Veuillez réessayer.`,
        }),
      };
    }

    // ── 3. Extract captured amount ────────────────────────────────────────
    const capture          = order.purchase_units?.[0]?.payments?.captures?.[0];
    const capturedAmount   = parseFloat(capture?.amount?.value   || '0');
    const capturedCurrency = capture?.amount?.currency_code       || '';
    const paypalCaptureId  = capture?.id                          || orderID;

    if (capturedCurrency !== 'EUR') {
      console.warn(`Currency mismatch: ${capturedCurrency} orderID=${orderID} IP=${clientIP}`);
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({ error: 'Devise de paiement invalide.' }),
      };
    }

    // ── 4. Assert amount matches server-computed expected price ───────────
    const expectedEUR = computeExpectedEUR(room, checkIn, checkOut, guests);
    const diff        = Math.abs(capturedAmount - expectedEUR);

    if (diff > AMOUNT_TOLERANCE) {
      // 🚨 SECURITY ALERT — log everything for forensics
      console.error(
        `PRICE_MISMATCH | orderID=${orderID} | captured=${capturedAmount} EUR | ` +
        `expected=${expectedEUR} EUR | diff=${diff} | ` +
        `room=${room} checkIn=${checkIn} checkOut=${checkOut} guests=${guests} | ` +
        `IP=${clientIP}`
      );
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: 'Le montant capturé ne correspond pas au prix attendu. La réservation ne peut pas être confirmée.',
        }),
      };
    }

    // ── 5. Generate reservation number server-side (crypto-secure) ────────
    const now      = new Date();
    const datePart = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const randPart = crypto.randomBytes(3).toString('hex').toUpperCase();
    const resNb    = `TH-${datePart}-${randPart}`;

    // ── 6. Compute final totals ───────────────────────────────────────────
    const totalMAD = computeTotalMAD(room, checkIn, checkOut, guests);
    const nights   = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
    const g        = parseInt(guests, 10);

    // Use server-side room name — never trust what the client sent
    const roomName = ROOM_CATALOG[room].name;

    // Sanitize free-text fields
    const safeName  = esc(name  || 'Client', 120);
    const safeEmail = email ? esc(email, 254) : '';

    // ── 7. Send email notification ────────────────────────────────────────
    await sendConfirmationEmail({
      resNb,
      name:     safeName,
      email:    safeEmail,
      room:     roomName,
      checkIn,
      checkOut,
      guests:   g,
      nights,
      totalMAD,
      totalEUR: capturedAmount.toFixed(2),
      paypalId: paypalCaptureId,
    });

    console.log(
      `Booking confirmed: ${resNb} | room=${roomName} | nights=${nights} | ` +
      `EUR=${capturedAmount} | IP=${clientIP}`
    );

    // ── 8. Return booking object to browser (stored in sessionStorage) ────
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:  true,
        resNb,
        room:     roomName,
        checkIn,
        checkOut,
        guests:   g,
        nights,
        totalMAD,
        totalEUR: capturedAmount.toFixed(2),
        paypalId: paypalCaptureId,
        // name/email intentionally omitted from response to avoid echoing PII
      }),
    };
  } catch (err) {
    console.error('verify-payment error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur interne. Veuillez réessayer.' }),
    };
  }
};
