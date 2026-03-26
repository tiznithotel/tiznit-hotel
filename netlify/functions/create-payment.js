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

  if (!res.ok) {
    const err = await res.text();
    console.error('PayPal token error:', err);
    throw new Error('PayPal authentication failed.');
  }

  const data = await res.json();
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
  // Allow the configured origin, or any Netlify preview URL for this site.
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
    console.warn(`Rate limit hit: ${clientIP}`);
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

  try {
    const { totalMAD, totalEUR, nights } = calculatePrice(
      room, checkIn, checkOut, guests
    );

    const token = await getPayPalAccessToken();
    const base  = process.env.PAYPAL_BASE_URL || 'https://api-m.paypal.com';

    // Idempotency key — prevents duplicate orders on retries
    const idempotencyKey = crypto.randomUUID();

    const orderRes = await fetch(`${base}/v2/checkout/orders`, {
      method:  'POST',
      headers: {
        Authorization:       `Bearer ${token}`,
        'Content-Type':      'application/json',
        'PayPal-Request-Id': idempotencyKey,
      },
      body: JSON.stringify({
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
              guests: String(guests),
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
      }),
    });

    if (!orderRes.ok) {
      const errBody = await orderRes.json().catch(() => ({}));
      console.error('PayPal order creation failed:', JSON.stringify(errBody));
      throw new Error("Impossible de créer l'ordre PayPal.");
    }

    const order = await orderRes.json();

    console.log(
      `Order created: ${order.id} | room=${room} | nights=${nights} | EUR=${totalEUR} | IP=${clientIP}`
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
    console.error('create-payment error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur interne. Veuillez réessayer.' }),
    };
  }
};
