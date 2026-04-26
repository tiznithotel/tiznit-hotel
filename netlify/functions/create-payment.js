/**
 * POST /.netlify/functions/create-payment
 *
 * Accepts booking parameters (multi-room model), validates server-side,
 * calculates the authoritative price, then creates a PayPal order.
 * Returns { orderID, totalMAD, totalEUR, nights } — the browser never sets the amount.
 *
 * Backward compat: if `rooms` is absent but `room` (string) is present,
 * auto-converts to rooms:[{type:room, qty:1}].
 */

'use strict';

const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));
const crypto = require('crypto');

// ─── Authoritative price catalog ─────────────────────────────────────────────
// capacity = max guests per room unit  →  Single:1 / Double:2 / Triple:3
const ROOM_CATALOG = {
  single: { name: 'Chambre Single', priceMAD: 247, capacity: 1 },
  double: { name: 'Chambre Double', priceMAD: 310, capacity: 2 },
  triple: { name: 'Chambre Triple', priceMAD: 438, capacity: 3 },
};
const BREAKFAST_PER_PERSON_PER_NIGHT = 36;
const TAX_PER_PERSON_PER_NIGHT       = 10;
const DISCOUNT_THRESHOLD_NIGHTS      = 5;
const DISCOUNT_RATE                  = 0.20;
const MAD_TO_EUR                     = 0.093;
const MAX_GUESTS                     = 20;
const MAX_STAY_NIGHTS                = 90;

// ─── Backward compat: room (string) → rooms (array) ──────────────────────────
function normaliseRooms(rawRooms, legacyRoom) {
  if (Array.isArray(rawRooms) && rawRooms.length > 0) return rawRooms;
  if (typeof legacyRoom === 'string' && ROOM_CATALOG[legacyRoom]) {
    return [{ type: legacyRoom, qty: 1 }];
  }
  return rawRooms; // let validation catch it
}

// ─── Rooms parser & validator ─────────────────────────────────────────────────
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

// ─── Input validation ─────────────────────────────────────────────────────────
function validateInput({ rooms: rawRooms, checkIn, checkOut, guests }) {
  const errors = [];

  // Dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ci = new Date(checkIn);
  const co = new Date(checkOut);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || isNaN(ci.getTime())) {
    errors.push("Date d'arrivée invalide.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || isNaN(co.getTime())) {
    errors.push('Date de départ invalide.');
  }

  if (errors.length === 0) {
    if (ci < today)  errors.push("La date d'arrivée ne peut pas être dans le passé.");
    if (co <= ci)    errors.push("La date de départ doit être après l'arrivée.");
    const nights = Math.round((co - ci) / 86400000);
    if (nights > MAX_STAY_NIGHTS) errors.push(`Séjour maximum : ${MAX_STAY_NIGHTS} nuits.`);
  }

  // Guests
  const g = parseInt(guests, 10);
  if (!Number.isInteger(g) || g < 1 || g > MAX_GUESTS) {
    errors.push(`Nombre de voyageurs invalide (1–${MAX_GUESTS}).`);
  }

  // Rooms
  const { valid: roomsValid, rooms: parsedRooms, errors: roomErrors } = parseRooms(rawRooms);
  errors.push(...roomErrors);

  // Capacity check (only when both rooms and guests are individually valid)
  if (roomsValid && Number.isInteger(g) && g >= 1) {
    const capacity = parsedRooms.reduce(
      (sum, r) => sum + (ROOM_CATALOG[r.type]?.capacity ?? 0) * r.qty, 0
    );
    if (g > capacity) {
      errors.push(
        `Capacité insuffisante : ${capacity} place(s) disponible(s) pour ${g} personne(s).`
      );
    }
  }

  return errors;
}

// ─── Price engine (single source of truth) ───────────────────────────────────
function calculatePrice(rooms, checkIn, checkOut, guests) {
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const g      = parseInt(guests, 10);

  const roomCost  = rooms.reduce(
    (sum, r) => sum + ROOM_CATALOG[r.type].priceMAD * r.qty * nights, 0
  );
  const breakfast = BREAKFAST_PER_PERSON_PER_NIGHT * g * nights;
  const tax       = TAX_PER_PERSON_PER_NIGHT * g * nights;
  let   totalMAD  = roomCost + breakfast + tax;

  if (nights >= DISCOUNT_THRESHOLD_NIGHTS) {
    totalMAD = Math.round(totalMAD * (1 - DISCOUNT_RATE));
  }

  const totalEUR = (totalMAD * MAD_TO_EUR).toFixed(2);
  return { totalMAD, totalEUR, nights };
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

// ─── PayPal: obtain access token ─────────────────────────────────────────────
async function getPayPalAccessToken(base) {
  const clientIdSet = Boolean(process.env.PAYPAL_CLIENT_ID);
  const secretSet   = Boolean(process.env.PAYPAL_SECRET);
  console.log(
    `[create-payment] ENV CHECK | ` +
    `PAYPAL_CLIENT_ID=${clientIdSet ? `SET (length=${process.env.PAYPAL_CLIENT_ID.length})` : '*** MISSING ***'} | ` +
    `PAYPAL_SECRET=${secretSet ? `SET (length=${process.env.PAYPAL_SECRET.length})` : '*** MISSING ***'}`
  );
  if (!clientIdSet || !secretSet) {
    throw new Error(
      'Missing PayPal credentials — set PAYPAL_CLIENT_ID and PAYPAL_SECRET ' +
      'in Netlify → Site configuration → Environment variables.'
    );
  }

  const tokenUrl    = `${base}/v1/oauth2/token`;
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString('base64');

  console.log(`[create-payment] PayPal token request → ${tokenUrl}`);

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
      `[create-payment] ❌ PayPal TOKEN failed | HTTP ${res.status} | ` +
      `paypal_error=${JSON.stringify(errPayload)}`
    );
    const err = new Error(`PayPal token request failed (HTTP ${res.status}): ${JSON.stringify(errPayload)}`);
    err.paypalStatus  = res.status;
    err.paypalPayload = errPayload;
    throw err;
  }

  const data = await res.json();
  console.log(
    `[create-payment] ✅ PayPal token obtained | token_type=${data.token_type} | expires_in=${data.expires_in}s`
  );
  return data.access_token;
}

// ─── Rate limiting (in-memory per function instance) ─────────────────────────
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
    'Access-Control-Max-Age':       '86400',
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
    console.warn(`[create-payment] Rate limit hit | IP=${clientIP}`);
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

  // Backward compat: if `room` (string) is sent instead of `rooms` (array), convert
  const rawRooms = normaliseRooms(body.rooms, body.room);
  const { checkIn, checkOut, guests } = body;

  // Server-side validation
  const errors = validateInput({ rooms: rawRooms, checkIn, checkOut, guests });
  if (errors.length > 0) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ error: 'Données invalides.', details: errors }),
    };
  }

  const { rooms } = parseRooms(rawRooms);
  const base      = process.env.PAYPAL_BASE_URL || 'https://api-m.paypal.com';
  const roomLabel = buildRoomLabel(rooms);

  console.log(
    `[create-payment] ▶ invocation | IP=${clientIP} | rooms=${roomLabel} | ` +
    `checkIn=${checkIn} | checkOut=${checkOut} | guests=${guests} | ` +
    `PAYPAL_BASE_URL=${base} (${process.env.PAYPAL_BASE_URL ? 'from env' : 'default'})`
  );

  try {
    const { totalMAD, totalEUR, nights } = calculatePrice(rooms, checkIn, checkOut, guests);

    console.log(
      `[create-payment] Price computed | ${roomLabel} | nights=${nights} | ` +
      `totalMAD=${totalMAD} | totalEUR=${totalEUR}`
    );

    const token          = await getPayPalAccessToken(base);
    const idempotencyKey = crypto.randomUUID();
    const orderUrl       = `${base}/v2/checkout/orders`;

    // Compact custom_id (max 127 chars) — read back by verify-payment server-side.
    // Stores the authoritative booking params so verify-payment never has to trust
    // what the browser sends after capture.
    const s = rooms.find(r => r.type === 'single')?.qty ?? 0;
    const d = rooms.find(r => r.type === 'double')?.qty ?? 0;
    const t = rooms.find(r => r.type === 'triple')?.qty ?? 0;
    const customId = JSON.stringify({
      s, d, t,
      ci: checkIn,
      co: checkOut,
      g:  String(guests),
      m:  String(totalMAD),
    });

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        description: `Tiznit Hotel — ${roomLabel} — ${guests} pers. — ${nights} nuit(s)`,
        amount: { currency_code: 'EUR', value: totalEUR },
        custom_id: customId,
      }],
      application_context: {
        brand_name:          'Tiznit Hotel',
        landing_page:        'BILLING',
        user_action:         'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    };

    console.log(
      `[create-payment] PayPal order request → ${orderUrl} | ` +
      `idempotency_key=${idempotencyKey} | custom_id_len=${customId.length}`
    );

    const orderRes = await fetch(orderUrl, {
      method:  'POST',
      headers: {
        Authorization:       `Bearer ${token}`,
        'Content-Type':      'application/json',
        'PayPal-Request-Id': idempotencyKey,
      },
      body: JSON.stringify(orderPayload),
    });

    if (!orderRes.ok) {
      let errBody;
      try   { errBody = await orderRes.json(); }
      catch { errBody = { raw: await orderRes.text() }; }
      console.error(
        `[create-payment] ❌ PayPal ORDER failed | HTTP ${orderRes.status} | ` +
        `paypal_error=${JSON.stringify(errBody)}`
      );
      const err = new Error(
        `PayPal order creation failed (HTTP ${orderRes.status}): ` +
        `${errBody.name || ''} — ${errBody.message || JSON.stringify(errBody)}`
      );
      err.paypalStatus  = orderRes.status;
      err.paypalPayload = errBody;
      throw err;
    }

    const order = await orderRes.json();
    console.log(
      `[create-payment] ✅ PayPal order CREATED | id=${order.id} | status=${order.status} | ` +
      `currency=${order.purchase_units?.[0]?.amount?.currency_code} | ` +
      `value=${order.purchase_units?.[0]?.amount?.value}`
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ orderID: order.id, totalMAD, totalEUR, nights }),
    };

  } catch (err) {
    console.error(
      `[create-payment] ❌ FATAL | message=${err.message} | ` +
      `paypalStatus=${err.paypalStatus || 'n/a'} | ` +
      `paypalPayload=${err.paypalPayload ? JSON.stringify(err.paypalPayload) : 'n/a'} | ` +
      `stack=${err.stack || 'n/a'}`
    );
    return {
      statusCode: err.paypalStatus ? 502 : 500,
      headers,
      body: JSON.stringify({
        error: err.message,
        ...(err.paypalStatus  && { paypalHttpStatus: err.paypalStatus }),
        ...(err.paypalPayload && { paypalError:      err.paypalPayload }),
      }),
    };
  }
};
