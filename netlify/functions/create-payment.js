/**
 * POST /.netlify/functions/create-payment
 *
 * Accepts booking parameters, validates them server-side, calculates the
 * authoritative price, then creates a PayPal order via the server-to-server
 * Orders API.  Returns { orderID, totalMAD, totalEUR, nights } to the
 * browser.  The browser never sets the amount — the server does.
 */

'use strict';

const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));
const crypto = require('crypto');

// ─── Authoritative price catalog (never sent to the client as a source of truth) ──
const ROOM_CATALOG = {
  single: { name: 'Chambre Single', priceMAD: 247, maxGuests: 2 },
  double: { name: 'Chambre Double', priceMAD: 310, maxGuests: 3 },
  triple: { name: 'Chambre Triple', priceMAD: 438, maxGuests: 4 },
};
const BREAKFAST_PER_PERSON_PER_NIGHT = 36;
const TAX_PER_PERSON_PER_NIGHT       = 10;
const DISCOUNT_THRESHOLD_NIGHTS      = 5;
const DISCOUNT_RATE                  = 0.20;
const MAD_TO_EUR                     = 0.093;
const MAX_STAY_NIGHTS                = 90;

// ─── Input validation ─────────────────────────────────────────────────────────
function validateInput({ room, checkIn, checkOut, guests }) {
  const errors = [];

  if (!room || !ROOM_CATALOG[room]) {
    errors.push('Type de chambre invalide.');
  }

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
    if (ci < today) {
      errors.push("La date d'arrivée ne peut pas être dans le passé.");
    }
    if (co <= ci) {
      errors.push("La date de départ doit être après l'arrivée.");
    }
    const nights = Math.round((co - ci) / 86400000);
    if (nights > MAX_STAY_NIGHTS) {
      errors.push(`Séjour maximum : ${MAX_STAY_NIGHTS} nuits.`);
    }
  }

  const g = parseInt(guests, 10);
  if (!Number.isInteger(g) || g < 1 || g > 4) {
    errors.push('Nombre de voyageurs invalide (1–4).');
  } else if (room && ROOM_CATALOG[room] && g > ROOM_CATALOG[room].maxGuests) {
    errors.push(
      `Capacité maximale pour cette chambre : ${ROOM_CATALOG[room].maxGuests} personnes.`
    );
  }

  return errors;
}

// ─── Price engine (single source of truth) ───────────────────────────────────
function calculatePrice(room, checkIn, checkOut, guests) {
  const r      = ROOM_CATALOG[room];
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const g      = parseInt(guests, 10);

  const roomCost  = r.priceMAD * nights;
  const breakfast = BREAKFAST_PER_PERSON_PER_NIGHT * g * nights;
  const tax       = TAX_PER_PERSON_PER_NIGHT * g * nights;
  let   totalMAD  = roomCost + breakfast + tax;

  if (nights > DISCOUNT_THRESHOLD_NIGHTS) {
    totalMAD = Math.round(totalMAD * (1 - DISCOUNT_RATE));
  }

  const totalEUR = (totalMAD * MAD_TO_EUR).toFixed(2);
  return { totalMAD, totalEUR, nights };
}

// ─── PayPal: obtain access token ─────────────────────────────────────────────
async function getPayPalAccessToken(base) {

  // ── REQ 3: Confirm env vars are present before using them ────────────────
  // Log presence and key length (never the actual value)
  const clientIdSet = Boolean(process.env.PAYPAL_CLIENT_ID);
  const secretSet   = Boolean(process.env.PAYPAL_SECRET);
  console.log(
    `[create-payment] ENV CHECK | ` +
    `PAYPAL_CLIENT_ID=${clientIdSet
      ? `SET (length=${process.env.PAYPAL_CLIENT_ID.length})`
      : '*** MISSING ***'} | ` +
    `PAYPAL_SECRET=${secretSet
      ? `SET (length=${process.env.PAYPAL_SECRET.length})`
      : '*** MISSING ***'}`
  );

  if (!clientIdSet || !secretSet) {
    throw new Error(
      'Missing PayPal credentials — set PAYPAL_CLIENT_ID and PAYPAL_SECRET ' +
      'in Netlify → Site configuration → Environment variables.'
    );
  }

  // ── REQ 4: Log the exact URL being called so live vs sandbox is obvious ──
  const tokenUrl = `${base}/v1/oauth2/token`;
  console.log(`[create-payment] PayPal token request → ${tokenUrl}`);

  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString('base64');

  const res = await fetch(tokenUrl, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  // ── REQ 2 + 5: Log every PayPal token error in full ──────────────────────
  if (!res.ok) {
    let errPayload;
    try   { errPayload = await res.json(); }
    catch { errPayload = { raw: await res.text() }; }

    console.error(
      `[create-payment] ❌ PayPal TOKEN failed | ` +
      `HTTP ${res.status} ${res.statusText} | ` +
      `url=${tokenUrl} | ` +
      `paypal_error=${JSON.stringify(errPayload)}`
    );

    // Carry the full PayPal error forward so the outer catch can log it too
    const err = new Error(
      `PayPal token request failed (HTTP ${res.status}): ${JSON.stringify(errPayload)}`
    );
    err.paypalStatus  = res.status;
    err.paypalPayload = errPayload;
    throw err;
  }

  const data = await res.json();

  // ── REQ 1: Confirm token obtained — log scope and lifetime, never the token ─
  console.log(
    `[create-payment] ✅ PayPal token obtained | ` +
    `token_type=${data.token_type} | ` +
    `expires_in=${data.expires_in}s | ` +
    `scope="${data.scope}"`
  );

  return data.access_token;
}

// ─── Rate limiting (in-memory per function instance) ─────────────────────────
// For production scale, replace with Redis via Upstash or Netlify Edge.
const rlStore = new Map();

function isRateLimited(ip) {
  const now    = Date.now();
  const window = 60_000; // 1 minute
  const limit  = 5;      // max requests per window
  const entry  = rlStore.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > window) {
    entry.count       = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }

  rlStore.set(ip, entry);
  return entry.count > limit;
}

// ─── CORS helper ─────────────────────────────────────────────────────────────
function corsHeaders(event) {
  const allowed = process.env.ALLOWED_ORIGIN || '';
  const origin  = event.headers['origin'] || '';
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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  // Rate limit by IP
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

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Corps de requête invalide.' }),
    };
  }

  const { room, checkIn, checkOut, guests } = body;

  // Server-side validation
  const errors = validateInput({ room, checkIn, checkOut, guests });
  if (errors.length > 0) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ error: 'Données invalides.', details: errors }),
    };
  }

  // ── REQ 4: Resolve and log the base URL once — visible in every invocation ──
  const base = process.env.PAYPAL_BASE_URL || 'https://api-m.paypal.com';
  console.log(
    `[create-payment] ▶ invocation start | ` +
    `IP=${clientIP} | room=${room} | checkIn=${checkIn} | checkOut=${checkOut} | guests=${guests} | ` +
    `PAYPAL_BASE_URL=${base} (${process.env.PAYPAL_BASE_URL ? 'from env' : 'using default'})`
  );

  try {
    const { totalMAD, totalEUR, nights } = calculatePrice(
      room, checkIn, checkOut, guests
    );

    console.log(
      `[create-payment] Price computed | room=${room} | nights=${nights} | ` +
      `totalMAD=${totalMAD} | totalEUR=${totalEUR}`
    );

    // Pass base into getPayPalAccessToken so it uses the same URL
    const token = await getPayPalAccessToken(base);

    // Idempotency key — prevents duplicate orders on retries
    const idempotencyKey = crypto.randomUUID();
    const orderUrl       = `${base}/v2/checkout/orders`;

    // Build the order payload
    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: `Tiznit Hotel — ${ROOM_CATALOG[room].name} — ${nights} nuit(s) — ${checkIn} au ${checkOut}`,
          amount: {
            currency_code: 'EUR',
            value:         totalEUR,   // amount set by server, not client
          },
          // Stash booking params for cross-verification in verify-payment
          custom_id: JSON.stringify({
            room,
            checkIn,
            checkOut,
            guests:   String(guests),
            totalMAD: String(totalMAD),
          }),
        },
      ],
      application_context: {
        brand_name:          'Tiznit Hotel',
        landing_page:        'NO_PREFERENCE',
        user_action:         'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    };

    // ── REQ 1 + 4: Log the full request being sent to PayPal ─────────────
    console.log(
      `[create-payment] PayPal order request → ${orderUrl} | ` +
      `idempotency_key=${idempotencyKey} | ` +
      `payload=${JSON.stringify(orderPayload)}`
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

    // ── REQ 2 + 5: On failure log the complete PayPal error payload ───────
    if (!orderRes.ok) {
      let errBody;
      try   { errBody = await orderRes.json(); }
      catch { errBody = { raw: await orderRes.text() }; }

      console.error(
        `[create-payment] ❌ PayPal ORDER creation failed | ` +
        `HTTP ${orderRes.status} ${orderRes.statusText} | ` +
        `url=${orderUrl} | ` +
        `paypal_error_name=${errBody.name || 'n/a'} | ` +
        `paypal_error_message=${errBody.message || 'n/a'} | ` +
        `paypal_error_details=${JSON.stringify(errBody.details || [])} | ` +
        `full_response=${JSON.stringify(errBody)}`
      );

      // Attach full PayPal payload to the thrown error so the catch block
      // can log it again if needed — nothing is lost
      const err = new Error(
        `PayPal order creation failed (HTTP ${orderRes.status}): ` +
        `${errBody.name || ''} — ${errBody.message || JSON.stringify(errBody)}`
      );
      err.paypalStatus  = orderRes.status;
      err.paypalPayload = errBody;
      throw err;
    }

    // ── REQ 1: Log the full successful PayPal order response ─────────────
    const order = await orderRes.json();
    console.log(
      `[create-payment] ✅ PayPal order CREATED | ` +
      `id=${order.id} | ` +
      `status=${order.status} | ` +
      `intent=${order.intent} | ` +
      `currency=${order.purchase_units?.[0]?.amount?.currency_code} | ` +
      `value=${order.purchase_units?.[0]?.amount?.value} | ` +
      `links=${JSON.stringify((order.links || []).map(l => `${l.rel}:${l.href}`))}`
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        orderID:  order.id,
        totalMAD,
        totalEUR,
        nights,
      }),
    };

  } catch (err) {
    // ── Surface the full error in the function logs ───────────────────────
    // PayPal errors carry .paypalStatus and .paypalPayload (attached above).
    // Config / JS errors carry .stack only.
    console.error(
      `[create-payment] ❌ FATAL | ` +
      `message=${err.message} | ` +
      `paypalStatus=${err.paypalStatus || 'n/a'} | ` +
      `paypalPayload=${err.paypalPayload ? JSON.stringify(err.paypalPayload) : 'n/a'} | ` +
      `stack=${err.stack || 'n/a'}`
    );

    // ── Return a clear, structured JSON error instead of a generic message ─
    // PayPal API errors  → 502 + the exact PayPal error object
    // Config/credential  → 500 + the actionable message
    // Unexpected JS error→ 500 + err.message (never a blank "internal error")
    const statusCode = err.paypalStatus ? 502 : 500;
    const body = {
      error: err.message,
      ...(err.paypalStatus  && { paypalHttpStatus: err.paypalStatus }),
      ...(err.paypalPayload && { paypalError:      err.paypalPayload }),
    };

    return {
      statusCode,
      headers,
      body: JSON.stringify(body),
    };
  }
};
