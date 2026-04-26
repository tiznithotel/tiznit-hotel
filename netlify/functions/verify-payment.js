/**
 * POST /.netlify/functions/verify-payment
 *
 * Called by the browser after PayPal's onApprove fires.
 *
 * Security model:
 *   1. Re-validates all booking inputs server-side (front-sent, for early rejection).
 *   2. Fetches the PayPal order server-to-server (never trusts the browser).
 *   3. Reads the authoritative booking params from custom_id (set by create-payment) —
 *      the browser cannot forge or alter these values.
 *   4. Recomputes the expected price from custom_id data only.
 *   5. Asserts captured EUR === expected EUR (±2¢ tolerance) → rejects on mismatch.
 *   6. Sends confirmation email via Resend (includes optional client comment).
 *   7. Returns booking details to the client (stored in sessionStorage, NOT URL).
 *
 * Backward compat: if `rooms` is absent but `room` (string) is present, auto-converts.
 * Comment: accepted from the front, sanitized server-side, never in custom_id.
 */

'use strict';

const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));
const crypto = require('crypto');

// ─── Authoritative price catalog (must match create-payment.js exactly) ───────
// capacity = max guests per room unit  →  Single:1 / Double:2 / Triple:3
const ROOM_CATALOG = {
  single: { name: 'Chambre Single', priceMAD: 247, capacity: 1 },
  double: { name: 'Chambre Double', priceMAD: 310, capacity: 2 },
  triple: { name: 'Chambre Triple', priceMAD: 438, capacity: 3 },
};
const BREAKFAST        = 36;
const TAX              = 10;
const MAD_TO_EUR       = 0.093;
const AMOUNT_TOLERANCE = 0.02; // 2-cent rounding tolerance
const MAX_GUESTS       = 20;
const MAX_STAY_NIGHTS  = 90;

// ─── Backward compat: room (string) → rooms (array) ──────────────────────────
function normaliseRooms(rawRooms, legacyRoom) {
  if (Array.isArray(rawRooms) && rawRooms.length > 0) return rawRooms;
  if (typeof legacyRoom === 'string' && ROOM_CATALOG[legacyRoom]) {
    return [{ type: legacyRoom, qty: 1 }];
  }
  return rawRooms;
}

// ─── Rooms parser ─────────────────────────────────────────────────────────────
function parseRooms(raw) {
  const errors = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { valid: false, rooms: [], errors: ['Au moins une chambre est requise.'] };
  }
  const validTypes = Object.keys(ROOM_CATALOG);
  const rooms = [];
  for (const r of raw) {
    if (!r || !validTypes.includes(r.type)) {
      errors.push(`Type de chambre invalide : "${r && r.type}".`);
      continue;
    }
    const qty = parseInt(r.qty, 10);
    if (!Number.isInteger(qty) || qty < 0) {
      errors.push(`Quantité invalide pour ${r.type}.`);
      continue;
    }
    rooms.push({ type: r.type, qty });
  }
  const totalRooms = rooms.reduce((s, r) => s + r.qty, 0);
  if (errors.length === 0 && totalRooms === 0) {
    errors.push('Au moins une chambre est requise.');
  }
  return { valid: errors.length === 0, rooms, errors };
}

// ─── Early input validation (front-sent data, for UX rejection before PayPal) ─
function validateInput({ orderID, rooms: rawRooms, checkIn, checkOut, guests, name, email }) {
  const errors = [];

  if (!orderID || typeof orderID !== 'string' || !/^[A-Z0-9]{17}$/.test(orderID)) {
    errors.push('Order ID PayPal invalide.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn))  errors.push("Date d'arrivée invalide.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) errors.push('Date de départ invalide.');

  if (errors.length === 0) {
    const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
    if (new Date(checkOut) <= new Date(checkIn)) errors.push("La date de départ doit être après l'arrivée.");
    if (nights > MAX_STAY_NIGHTS) errors.push(`Séjour maximum : ${MAX_STAY_NIGHTS} nuits.`);
  }

  const g = parseInt(guests, 10);
  if (!Number.isInteger(g) || g < 1 || g > MAX_GUESTS) {
    errors.push(`Nombre de voyageurs invalide (1–${MAX_GUESTS}).`);
  }

  const { valid: roomsValid, rooms: parsedRooms, errors: roomErrors } = parseRooms(rawRooms);
  errors.push(...roomErrors);

  if (roomsValid && Number.isInteger(g) && g >= 1) {
    const capacity = parsedRooms.reduce(
      (sum, r) => sum + (ROOM_CATALOG[r.type]?.capacity ?? 0) * r.qty, 0
    );
    if (g > capacity) {
      errors.push(`Capacité insuffisante : ${capacity} place(s) pour ${g} personne(s).`);
    }
  }

  if (name && (typeof name !== 'string' || name.length > 120)) errors.push('Nom invalide.');
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) {
    errors.push('Adresse email invalide.');
  }

  return errors;
}

// ─── Price engines (must match create-payment.js exactly) ────────────────────
function computeExpectedEUR(rooms, checkIn, checkOut, guests) {
  const nights   = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const g        = parseInt(guests, 10);
  const roomCost = rooms.reduce((s, r) => s + ROOM_CATALOG[r.type].priceMAD * r.qty * nights, 0);
  let   total    = roomCost + BREAKFAST * g * nights + TAX * g * nights;
  if (nights >= 5) total = Math.round(total * 0.8);
  return parseFloat((total * MAD_TO_EUR).toFixed(2));
}

function computeTotalMAD(rooms, checkIn, checkOut, guests) {
  const nights   = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const g        = parseInt(guests, 10);
  const roomCost = rooms.reduce((s, r) => s + ROOM_CATALOG[r.type].priceMAD * r.qty * nights, 0);
  let   total    = roomCost + BREAKFAST * g * nights + TAX * g * nights;
  if (nights >= 5) total = Math.round(total * 0.8);
  return total;
}

// ─── Parse the custom_id stored by create-payment ────────────────────────────
// Returns authoritative booking params or throws.
function parseCustomId(customIdStr, orderID) {
  if (!customIdStr) {
    console.error(`[verify-payment] Missing custom_id | orderID=${orderID}`);
    throw new Error('Données de réservation introuvables dans la commande PayPal.');
  }
  let data;
  try {
    data = JSON.parse(customIdStr);
  } catch {
    console.error(`[verify-payment] Invalid custom_id JSON | orderID=${orderID} | raw=${customIdStr}`);
    throw new Error('Données de réservation corrompues dans la commande PayPal.');
  }

  const authRooms = [
    { type: 'single', qty: Math.max(0, parseInt(data.s, 10) || 0) },
    { type: 'double', qty: Math.max(0, parseInt(data.d, 10) || 0) },
    { type: 'triple', qty: Math.max(0, parseInt(data.t, 10) || 0) },
  ].filter(r => r.qty > 0);

  const authCheckIn  = String(data.ci || '');
  const authCheckOut = String(data.co || '');
  const authGuests   = Math.max(1, parseInt(data.g, 10) || 1);
  const authTotalMAD = parseInt(data.m, 10) || 0; // stored for cross-check / logging

  if (authRooms.length === 0 || !authCheckIn || !authCheckOut) {
    console.error(
      `[verify-payment] Incomplete custom_id | orderID=${orderID} | raw=${customIdStr}`
    );
    throw new Error('Données de réservation incomplètes dans la commande PayPal.');
  }

  return { authRooms, authCheckIn, authCheckOut, authGuests, authTotalMAD };
}

// ─── Human-readable room label ────────────────────────────────────────────────
function buildRoomLabel(rooms) {
  return rooms
    .filter(r => r.qty > 0)
    .map(r => {
      const base = ROOM_CATALOG[r.type].name;
      return `${r.qty} ${r.qty > 1 ? base.replace('Chambre ', 'Chambres ') + 's' : base}`;
    })
    .join(' + ');
}

// ─── Sanitize user text for safe HTML email embedding ────────────────────────
function esc(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLen)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// ─── PayPal helpers ───────────────────────────────────────────────────────────
async function getPayPalAccessToken() {
  const base        = process.env.PAYPAL_BASE_URL || 'https://api-m.paypal.com';
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method:  'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal authentication failed.');
  return (await res.json()).access_token;
}

async function fetchPayPalOrder(orderID, token) {
  const base = process.env.PAYPAL_BASE_URL || 'https://api-m.paypal.com';
  const res  = await fetch(`${base}/v2/checkout/orders/${orderID}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    console.error(`[verify-payment] PayPal order fetch failed | orderID=${orderID} | HTTP=${res.status}`);
    throw new Error('Impossible de vérifier le paiement PayPal.');
  }
  return res.json();
}

// ─── Email notification ───────────────────────────────────────────────────────
async function sendConfirmationEmail({
  resNb, name, email, roomLabel, checkIn, checkOut,
  guests, nights, totalMAD, totalEUR, paypalId, comment,
}) {
  // One <tr> per room type in the booking
  const roomRows = roomLabel.split(' + ').map(r =>
    `<tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Chambre</td>` +
    `<td style="padding:8px 0;font-weight:bold;font-size:14px">${esc(r)}</td></tr>`
  ).join('');

  const commentRow = comment
    ? `<tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Commentaire</td>` +
      `<td style="padding:8px 0;font-size:14px;font-style:italic">${esc(comment, 500)}</td></tr>`
    : '';

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
    ${roomRows}
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Arriv&#xe9;e</td>
        <td style="padding:8px 0;font-size:14px">${esc(checkIn)}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">D&#xe9;part</td>
        <td style="padding:8px 0;font-size:14px">${esc(checkOut)}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Nuits</td>
        <td style="padding:8px 0;font-size:14px">${esc(String(nights))}</td></tr>
    <tr><td style="padding:8px 0;color:#8a7d6b;font-size:14px">Voyageurs</td>
        <td style="padding:8px 0;font-size:14px">${esc(String(guests))}</td></tr>
    ${commentRow}
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
    &#x26A0;&#xFE0F; G&#xe9;n&#xe9;r&#xe9; automatiquement apr&#xe8;s v&#xe9;rification serveur du paiement PayPal.
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
      subject: `✅ Réservation ${esc(resNb)} — ${esc(roomLabel)}`,
      html,
    }),
  });

  if (!res.ok) {
    // Email failure must NOT block the booking confirmation
    const err = await res.json().catch(() => ({}));
    console.error('[verify-payment] Email send failed:', JSON.stringify(err));
  }
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const rlStore = new Map();
function isRateLimited(ip) {
  const now   = Date.now(), window = 60_000, limit = 5;
  const entry = rlStore.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > window) { entry.count = 1; entry.windowStart = now; }
  else { entry.count++; }
  rlStore.set(ip, entry);
  return entry.count > limit;
}

// ─── CORS helper ─────────────────────────────────────────────────────────────
function corsHeaders(event) {
  const allowed   = process.env.ALLOWED_ORIGIN || '';
  const origin    = event.headers['origin'] || '';
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

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const clientIP =
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  if (isRateLimited(clientIP)) {
    console.warn(`[verify-payment] Rate limit hit | IP=${clientIP}`);
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

  const { orderID, name, email, comment } = body;

  // Backward compat: room (string) → rooms (array)
  const rawRooms = normaliseRooms(body.rooms, body.room);
  const { checkIn, checkOut, guests } = body;

  // ── Early validation (front-sent data) — for meaningful UX error messages ──
  // Note: these values are NOT used for price verification (custom_id is).
  const errors = validateInput({ orderID, rooms: rawRooms, checkIn, checkOut, guests, name, email });
  if (errors.length > 0) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ error: 'Données invalides.', details: errors }),
    };
  }

  try {
    // ── 1. Fetch PayPal order server-to-server ────────────────────────────────
    const token = await getPayPalAccessToken();
    const order = await fetchPayPalOrder(orderID, token);

    // ── 2. Assert the order is fully captured ────────────────────────────────
    if (order.status !== 'COMPLETED') {
      console.warn(
        `[verify-payment] Payment not COMPLETED | status=${order.status} | orderID=${orderID} | IP=${clientIP}`
      );
      return {
        statusCode: 402,
        headers,
        body: JSON.stringify({
          error: `Paiement non confirmé (statut : ${order.status}). Veuillez réessayer.`,
        }),
      };
    }

    // ── 3. Extract captured amount ────────────────────────────────────────────
    const capture          = order.purchase_units?.[0]?.payments?.captures?.[0];
    const capturedAmount   = parseFloat(capture?.amount?.value   || '0');
    const capturedCurrency = capture?.amount?.currency_code       || '';
    const paypalCaptureId  = capture?.id                          || orderID;

    if (capturedCurrency !== 'EUR') {
      console.warn(
        `[verify-payment] Currency mismatch | currency=${capturedCurrency} | orderID=${orderID}`
      );
      return { statusCode: 422, headers, body: JSON.stringify({ error: 'Devise de paiement invalide.' }) };
    }

    // ── 4. Read authoritative booking params from custom_id ───────────────────
    // This is the value our server stored when creating the order — the browser
    // cannot alter it.  All price verification uses these values, not the
    // front-sent rooms/dates/guests.
    const customIdStr = order.purchase_units?.[0]?.custom_id;
    const { authRooms, authCheckIn, authCheckOut, authGuests, authTotalMAD } =
      parseCustomId(customIdStr, orderID);

    const authRoomLabel = buildRoomLabel(authRooms);
    console.log(
      `[verify-payment] custom_id parsed | rooms=${authRoomLabel} | ` +
      `checkIn=${authCheckIn} | checkOut=${authCheckOut} | guests=${authGuests} | ` +
      `storedTotalMAD=${authTotalMAD} | orderID=${orderID}`
    );

    // ── 5. Recompute expected price from authoritative data ───────────────────
    const expectedEUR     = computeExpectedEUR(authRooms, authCheckIn, authCheckOut, authGuests);
    const recomputedMAD   = computeTotalMAD(authRooms, authCheckIn, authCheckOut, authGuests);
    const diff            = Math.abs(capturedAmount - expectedEUR);

    // Cross-check: stored totalMAD vs recomputed (should always match)
    if (recomputedMAD !== authTotalMAD) {
      console.warn(
        `[verify-payment] totalMAD mismatch between stored and recomputed | ` +
        `stored=${authTotalMAD} | recomputed=${recomputedMAD} | orderID=${orderID}`
      );
    }

    if (diff > 0.02) {
      // 🚨 SECURITY ALERT — log everything for forensics
      console.error(
        `[verify-payment] PRICE_MISMATCH | orderID=${orderID} | ` +
        `captured=${capturedAmount} EUR | expected=${expectedEUR} EUR | diff=${diff} | ` +
        `authRooms=${authRoomLabel} | checkIn=${authCheckIn} | checkOut=${authCheckOut} | ` +
        `guests=${authGuests} | IP=${clientIP}`
      );
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: 'Le montant capturé ne correspond pas au prix attendu. La réservation ne peut pas être confirmée.',
        }),
      };
    }

    // ── 6. Generate reservation number (crypto-secure) ────────────────────────
    const now      = new Date();
    const datePart = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const randPart = crypto.randomBytes(3).toString('hex').toUpperCase();
    const resNb    = `TH-${datePart}-${randPart}`;

    const authNights = Math.round(
      (new Date(authCheckOut) - new Date(authCheckIn)) / 86400000
    );

    // Sanitize free-text fields from the browser
    const safeName    = esc(name    || 'Client', 120);
    const safeEmail   = email   ? esc(email,   254) : '';
    const safeComment = comment ? esc(comment, 500) : '';

    // ── 7. Send email notification ────────────────────────────────────────────
    await sendConfirmationEmail({
      resNb,
      name:      safeName,
      email:     safeEmail,
      roomLabel: authRoomLabel,
      checkIn:   authCheckIn,
      checkOut:  authCheckOut,
      guests:    authGuests,
      nights:    authNights,
      totalMAD:  recomputedMAD,
      totalEUR:  capturedAmount.toFixed(2),
      paypalId:  paypalCaptureId,
      comment:   safeComment,
    });

    console.log(
      `[verify-payment] ✅ Booking confirmed | resNb=${resNb} | rooms=${authRoomLabel} | ` +
      `nights=${authNights} | EUR=${capturedAmount} | IP=${clientIP}`
    );

    // ── 8. Return booking to browser (stored in sessionStorage, not URL) ──────
    // `room` is a string for backward compat with merci.html.
    // name/email intentionally omitted — the browser already has them.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:  true,
        resNb,
        room:     authRoomLabel,   // merci.html reads b.room as a string
        checkIn:  authCheckIn,
        checkOut: authCheckOut,
        guests:   authGuests,
        nights:   authNights,
        totalMAD: recomputedMAD,
        totalEUR: capturedAmount.toFixed(2),
        paypalId: paypalCaptureId,
      }),
    };

  } catch (err) {
    console.error(`[verify-payment] ❌ FATAL | message=${err.message} | stack=${err.stack || 'n/a'}`);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur interne. Veuillez réessayer.' }),
    };
  }
};
