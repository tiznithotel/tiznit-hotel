/**
 * POST /api/verify-payment
 * ─────────────────────────────────────────────────────────────────────────────
 * Vercel serverless function — Node.js 18+ runtime (native fetch).
 *
 * Called by the browser immediately after PayPal's onApprove fires.
 *
 * Security steps performed on every call:
 *   1. Re-validate all booking inputs server-side (nothing from the client
 *      is trusted without validation).
 *   2. Fetch the PayPal order from PayPal's API server-to-server.
 *   3. Assert order.status === 'COMPLETED' (capture actually happened).
 *   4. Assert captured EUR amount === server-computed expected amount (±2¢).
 *      Any mismatch is logged as a SECURITY ALERT and the request is rejected.
 *   5. Generate a cryptographically-secure reservation number (crypto.randomBytes).
 *   6. Send confirmation email via Resend.
 *   7. Return booking details — stored in sessionStorage by the browser, NOT URL.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

// ─── PayPal environment selection ─────────────────────────────────────────────
const IS_SANDBOX = (process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox';

const PAYPAL_CLIENT_ID = IS_SANDBOX
  ? (process.env.PAYPAL_SANDBOX_CLIENT_ID || '')
  : (process.env.PAYPAL_CLIENT_ID || process.env.ID_CLIENT_PAYPAL || '');

const PAYPAL_SECRET = IS_SANDBOX
  ? (process.env.PAYPAL_SANDBOX_SECRET || '')
  : (process.env.PAYPAL_SECRET || process.env.SECRET_PAYPAL || '');

const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || process.env.URL_BASE_PAYPAL
  || (IS_SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.ORIGINE_AUTORIS || 'https://hoteltiznit.com';

// ─── Authoritative price catalog (must match create-payment.js exactly) ──────
const ROOM_CATALOG = {
  single: { name: 'Chambre Single', priceMAD: 247, maxGuests: 2 },
  double: { name: 'Chambre Double', priceMAD: 310, maxGuests: 3 },
  triple: { name: 'Chambre Triple', priceMAD: 438, maxGuests: 4 },
};
const BREAKFAST        = 36;
const TAX              = 10;
const MAD_TO_EUR       = 0.093;
const AMOUNT_TOLERANCE = 0.02;   // 2-cent rounding tolerance
const MAX_STAY_NIGHTS  = 90;

// ─── Price engine (must be identical to create-payment.js) ───────────────────
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

  // PayPal live order IDs are 17-character uppercase alphanumeric strings
  if (!orderID || typeof orderID !== 'string' || !/^[A-Z0-9]{17}$/.test(orderID)) {
    errors.push('Order ID PayPal invalide.');
  }

  if (!room || !ROOM_CATALOG[room]) {
    errors.push('Type de chambre invalide.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn))  errors.push("Date d'arrivée invalide.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) errors.push('Date de départ invalide.');

  if (errors.length === 0) {
    const ci     = new Date(checkIn);
    const co     = new Date(checkOut);
    const nights = Math.round((co - ci) / 86400000);
    if (co <= ci)                errors.push("La date de départ doit être après l'arrivée.");
    if (nights > MAX_STAY_NIGHTS) errors.push(`Séjour maximum : ${MAX_STAY_NIGHTS} nuits.`);
  }

  const g = parseInt(guests, 10);
  if (!Number.isInteger(g) || g < 1 || g > 4) {
    errors.push('Nombre de voyageurs invalide (1–4).');
  } else if (room && ROOM_CATALOG[room] && g > ROOM_CATALOG[room].maxGuests) {
    errors.push(`Capacité maximale : ${ROOM_CATALOG[room].maxGuests} personnes.`);
  }

  if (name  && (typeof name  !== 'string' || name.length  > 120)) errors.push('Nom invalide.');
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) {
    errors.push('Adresse email invalide.');
  }

  return errors;
}

// ─── HTML escape (for email template) ────────────────────────────────────────
function esc(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLen)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ─── PayPal: obtain OAuth2 access token ──────────────────────────────────────
async function getPayPalAccessToken(base) {
  const clientIdSet = Boolean(PAYPAL_CLIENT_ID);
  const secretSet   = Boolean(PAYPAL_SECRET);

  console.log(
    '[verify-payment] ENV CHECK | ' +
    `PAYPAL_CLIENT_ID=${clientIdSet
      ? 'SET (length=' + PAYPAL_CLIENT_ID.length + ')'
      : '*** MISSING — set PAYPAL_CLIENT_ID or ID_CLIENT_PAYPAL ***'} | ` +
    `PAYPAL_SECRET=${secretSet
      ? 'SET (length=' + PAYPAL_SECRET.length + ')'
      : '*** MISSING — set PAYPAL_SECRET or SECRET_PAYPAL ***'}`
  );

  if (!clientIdSet || !secretSet) {
    throw new Error(
      'Missing PayPal credentials — set PAYPAL_CLIENT_ID (or ID_CLIENT_PAYPAL) ' +
      'and PAYPAL_SECRET (or SECRET_PAYPAL) ' +
      'in Vercel → Project Settings → Environment Variables.'
    );
  }

  const tokenUrl    = `${base}/v1/oauth2/token`;
  const credentials = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`
  ).toString('base64');

  console.log(`[verify-payment] PayPal token request -> ${tokenUrl}`);

  const res = await fetch(tokenUrl, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    let errPayload;
    try   { errPayload = await res.json(); }
    catch { errPayload = { raw: await res.text() }; }

    console.error(
      '[verify-payment] PayPal TOKEN failed | ' +
      `HTTP ${res.status} ${res.statusText} | ` +
      `url=${tokenUrl} | ` +
      `paypal_error=${JSON.stringify(errPayload)}`
    );

    const err        = new Error(
      `PayPal token request failed (HTTP ${res.status}): ${JSON.stringify(errPayload)}`
    );
    err.paypalStatus  = res.status;
    err.paypalPayload = errPayload;
    throw err;
  }

  const data = await res.json();
  console.log(
    '[verify-payment] PayPal token obtained | ' +
    `token_type=${data.token_type} | expires_in=${data.expires_in}s`
  );
  return data.access_token;
}

// ─── PayPal: fetch order details ──────────────────────────────────────────────
async function fetchPayPalOrder(orderID, token, base) {
  const url = `${base}/v2/checkout/orders/${orderID}`;
  console.log(`[verify-payment] Fetching PayPal order -> ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    let errPayload;
    try   { errPayload = await res.json(); }
    catch { errPayload = { raw: await res.text() }; }

    console.error(
      `[verify-payment] PayPal order fetch failed | ` +
      `HTTP ${res.status} | orderID=${orderID} | ` +
      `paypal_error=${JSON.stringify(errPayload)}`
    );

    const err        = new Error(
      `PayPal order fetch failed (HTTP ${res.status}): ${JSON.stringify(errPayload)}`
    );
    err.paypalStatus  = res.status;
    err.paypalPayload = errPayload;
    throw err;
  }

  return res.json();
}

// ─── Email notification via Resend ───────────────────────────────────────────
async function sendConfirmationEmail({
  resNb, name, email, room, checkIn, checkOut,
  guests, nights, totalMAD, totalEUR, paypalId,
}) {
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
    &#x26A0;&#xFE0F; Ce message a &#xe9;t&#xe9; g&#xe9;n&#xe9;r&#xe9; automatiquement
    apr&#xe8;s v&#xe9;rification serveur du paiement PayPal.
  </p>
</div>`;

  console.log(`[verify-payment] Sending confirmation email for ${resNb}`);

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'Tiznit Hotel <onboarding@resend.dev>',
      to:      [process.env.NOTIFY_EMAIL],
      subject: `Reservation ${esc(resNb)} - ${esc(room)}`,
      html,
    }),
  });

  if (!res.ok) {
    // Email failure must NOT block the booking confirmation
    const errBody = await res.json().catch(() => ({}));
    console.error(
      `[verify-payment] Email send failed | resNb=${resNb} | ` +
      `resend_error=${JSON.stringify(errBody)}`
    );
  } else {
    console.log(`[verify-payment] Confirmation email sent | resNb=${resNb}`);
  }
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const rlStore = new Map();

function isRateLimited(ip) {
  const now    = Date.now();
  const WINDOW = 60_000;
  const LIMIT  = 5;
  const entry  = rlStore.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > WINDOW) { entry.count = 1; entry.windowStart = now; }
  else                                  { entry.count++; }
  rlStore.set(ip, entry);
  return entry.count > LIMIT;
}

// ─── CORS helper ─────────────────────────────────────────────────────────────
function setCorsHeaders(res, origin) {
  const isAllowed =
    origin === ALLOWED_ORIGIN ||
    origin === 'https://www.' + ALLOWED_ORIGIN.replace('https://', '') ||
    /^https:\/\/[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+\.vercel\.app$/.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) ||
    /^http:\/\/localhost(:\d+)?$/.test(origin);

  res.setHeader('Access-Control-Allow-Origin',  isAllowed ? origin : ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control',                'no-store');
}

// ─── Vercel handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  setCorsHeaders(res, origin);

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const clientIP =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  if (isRateLimited(clientIP)) {
    console.warn(`[verify-payment] Rate limit hit | IP=${clientIP}`);
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Trop de requêtes. Veuillez patienter 1 minute.',
    });
  }

  const body = req.body && typeof req.body === 'object'
    ? req.body
    : (() => {
        try { return JSON.parse(req.body || '{}'); }
        catch { return null; }
      })();

  if (!body) {
    return res.status(400).json({ error: 'Corps de requête invalide.' });
  }

  const { orderID, name, email, room, checkIn, checkOut, guests } = body;

  const base = PAYPAL_BASE_URL;

  console.log(
    '[verify-payment] Invocation start | ' +
    `IP=${clientIP} | orderID=${orderID} | room=${room} | ` +
    `checkIn=${checkIn} | checkOut=${checkOut} | guests=${guests} | ` +
    `PAYPAL_BASE_URL=${base} (${(process.env.PAYPAL_BASE_URL || process.env.URL_BASE_PAYPAL) ? 'from env' : 'using default'})`
  );

  // Server-side validation
  const errors = validateInput({ orderID, room, checkIn, checkOut, guests, name, email });
  if (errors.length > 0) {
    console.warn(
      `[verify-payment] Validation failed | IP=${clientIP} | errors=${JSON.stringify(errors)}`
    );
    return res.status(422).json({ error: 'Données invalides.', details: errors });
  }

  try {
    // ── 1. Verify payment with PayPal API (server-to-server) ──────────────────
    const token = await getPayPalAccessToken(base);
    const order = await fetchPayPalOrder(orderID, token, base);

    console.log(
      '[verify-payment] PayPal order retrieved | ' +
      `orderID=${orderID} | status=${order.status} | ` +
      `full_order=${JSON.stringify(order)}`
    );

    // ── 2. Assert the order is fully captured ─────────────────────────────────
    if (order.status !== 'COMPLETED') {
      console.warn(
        `[verify-payment] Payment NOT completed | ` +
        `status=${order.status} | orderID=${orderID} | IP=${clientIP}`
      );
      return res.status(402).json({
        error: `Paiement non confirmé (statut : ${order.status}). Veuillez réessayer.`,
      });
    }

    // ── 3. Extract captured amount ─────────────────────────────────────────────
    const capture          = order.purchase_units?.[0]?.payments?.captures?.[0];
    const capturedAmount   = parseFloat(capture?.amount?.value    || '0');
    const capturedCurrency = capture?.amount?.currency_code        || '';
    const paypalCaptureId  = capture?.id                           || orderID;

    console.log(
      '[verify-payment] Capture details | ' +
      `capturedAmount=${capturedAmount} | ` +
      `capturedCurrency=${capturedCurrency} | ` +
      `paypalCaptureId=${paypalCaptureId}`
    );

    if (capturedCurrency !== 'EUR') {
      console.warn(
        `[verify-payment] CURRENCY MISMATCH | ` +
        `expected=EUR | got=${capturedCurrency} | ` +
        `orderID=${orderID} | IP=${clientIP}`
      );
      return res.status(422).json({ error: 'Devise de paiement invalide.' });
    }

    // ── 4. Assert amount matches server-computed expected price ────────────────
    const expectedEUR = computeExpectedEUR(room, checkIn, checkOut, guests);
    const diff        = Math.abs(capturedAmount - expectedEUR);

    console.log(
      '[verify-payment] Amount check | ' +
      `capturedEUR=${capturedAmount} | expectedEUR=${expectedEUR} | diff=${diff} | ` +
      `tolerance=${AMOUNT_TOLERANCE}`
    );

    if (diff > AMOUNT_TOLERANCE) {
      // SECURITY ALERT — log everything needed for forensic investigation
      console.error(
        '[verify-payment] SECURITY: PRICE_MISMATCH | ' +
        `orderID=${orderID} | capturedEUR=${capturedAmount} | expectedEUR=${expectedEUR} | ` +
        `diff=${diff} | room=${room} | checkIn=${checkIn} | checkOut=${checkOut} | ` +
        `guests=${guests} | IP=${clientIP}`
      );
      return res.status(422).json({
        error:
          'Le montant capturé ne correspond pas au prix attendu. ' +
          'La réservation ne peut pas être confirmée.',
      });
    }

    // ── 5. Generate reservation number (crypto-secure, server-side only) ──────
    const now      = new Date();
    const datePart =
      String(now.getFullYear()).slice(-2) +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    const randPart = crypto.randomBytes(3).toString('hex').toUpperCase();
    const resNb    = `TH-${datePart}-${randPart}`;

    // ── 6. Compute final totals ────────────────────────────────────────────────
    const totalMAD = computeTotalMAD(room, checkIn, checkOut, guests);
    const nights   = Math.round(
      (new Date(checkOut) - new Date(checkIn)) / 86400000
    );
    const g        = parseInt(guests, 10);
    const roomName = ROOM_CATALOG[room].name;   // use server-side name, never client

    const safeName  = esc(name  || 'Client', 120);
    const safeEmail = email ? esc(email, 254) : '';

    // ── 7. Send confirmation email (non-blocking on failure) ──────────────────
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
      '[verify-payment] Booking confirmed | ' +
      `resNb=${resNb} | room=${roomName} | nights=${nights} | ` +
      `EUR=${capturedAmount} | IP=${clientIP}`
    );

    // ── 8. Return booking details (browser stores in sessionStorage, not URL) ─
    return res.status(200).json({
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
      // name/email intentionally excluded — PII should not be echoed back
    });

  } catch (err) {
    console.error(
      '[verify-payment] FATAL | ' +
      `message=${err.message} | ` +
      `paypalStatus=${err.paypalStatus || 'n/a'} | ` +
      `paypalPayload=${err.paypalPayload ? JSON.stringify(err.paypalPayload) : 'n/a'} | ` +
      `stack=${err.stack || 'n/a'}`
    );

    const statusCode = err.paypalStatus ? 502 : 500;
    return res.status(statusCode).json({
      error: err.message,
      ...(err.paypalStatus  && { paypalHttpStatus: err.paypalStatus }),
      ...(err.paypalPayload && { paypalError:      err.paypalPayload }),
    });
  }
};
