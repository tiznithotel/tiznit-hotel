/**
 * POST /api/create-payment
 * ─────────────────────────────────────────────────────────────────────────────
 * Vercel serverless function — Node.js 18+ runtime (native fetch, no node-fetch).
 *
 * Validates booking inputs server-side, computes the authoritative price,
 * then creates a PayPal order via the server-to-server Orders v2 API.
 * Returns { orderID, totalMAD, totalEUR, nights } to the browser.
 *
 * The browser NEVER sets the payment amount — this function does.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

// ─── PayPal environment selection ─────────────────────────────────────────────
// Set PAYPAL_ENV=sandbox in Vercel to use sandbox credentials.
// Omit or set PAYPAL_ENV=live for production.
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

// ─── Authoritative price catalog ─────────────────────────────────────────────
// Never expose this as a "source of truth" to the client.
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
const MAX_STAY_NIGHTS                = 90;

// ─── Rooms parser ─────────────────────────────────────────────────────────────
function parseRooms(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { valid: false, rooms: [], errors: ['Au moins une chambre est requise.'] };
  }
  const validTypes = Object.keys(ROOM_CATALOG);
  const errors = [], rooms = [];
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

  const g = parseInt(guests, 10);
  if (!Number.isInteger(g) || g < 1 || g > 20) {
    errors.push('Nombre de voyageurs invalide (1–20).');
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

  return errors;
}

// ─── Price engine (single source of truth) ───────────────────────────────────
function calculatePrice(rooms, checkIn, checkOut, guests) {
  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  const g      = parseInt(guests, 10);

  const roomCost  = rooms.reduce((sum, r) => sum + ROOM_CATALOG[r.type].priceMAD * r.qty * nights, 0);
  const breakfast = BREAKFAST_PER_PERSON_PER_NIGHT * g * nights;
  const tax       = TAX_PER_PERSON_PER_NIGHT * g * nights;
  let   totalMAD  = roomCost + breakfast + tax;

  if (nights > DISCOUNT_THRESHOLD_NIGHTS) {
    totalMAD = Math.round(totalMAD * (1 - DISCOUNT_RATE));
  }

  const totalEUR = (totalMAD * MAD_TO_EUR).toFixed(2);
  return { totalMAD, totalEUR, nights };
}

function buildRoomLabel(rooms) {
  return rooms
    .filter(r => r.qty > 0)
    .map(r => `${r.qty} ${r.qty > 1 ? ROOM_CATALOG[r.type].name.replace('Chambre ', 'Chambres ') + 's' : ROOM_CATALOG[r.type].name}`)
    .join(' + ');
}

// ─── PayPal: obtain OAuth2 access token (server-to-server) ───────────────────
async function getPayPalAccessToken(base) {
  // Log presence + length of credentials — never log the actual values
  const clientIdSet = Boolean(PAYPAL_CLIENT_ID);
  const secretSet   = Boolean(PAYPAL_SECRET);

  console.log(
    '[create-payment] ENV CHECK | ' +
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

  console.log(`[create-payment] PayPal token request -> ${tokenUrl}`);

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
      '[create-payment] PayPal TOKEN failed | ' +
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
    '[create-payment] PayPal token obtained | ' +
    `token_type=${data.token_type} | ` +
    `expires_in=${data.expires_in}s | ` +
    `scope="${data.scope}"`
  );

  return data.access_token;
}

// ─── Rate limiting (in-memory, per Vercel function instance) ─────────────────
// Each Vercel serverless invocation may run in a different container — this
// limits burst abuse within a single warm instance.  For global rate limiting
// use Upstash Redis + Vercel Edge Middleware.
const rlStore = new Map();

function isRateLimited(ip) {
  const now    = Date.now();
  const WINDOW = 60_000; // 1 minute
  const LIMIT  = 5;
  const entry  = rlStore.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > WINDOW) {
    entry.count       = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }

  rlStore.set(ip, entry);
  return entry.count > LIMIT;
}

// ─── CORS helper ─────────────────────────────────────────────────────────────
// In production on Vercel the API and frontend share the same domain, so
// CORS is technically same-origin.  We still set headers explicitly so
// preview deployments (*.vercel.app) and local dev work without friction.
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
  res.setHeader('Access-Control-Max-Age',       '86400');
  res.setHeader('Cache-Control',                'no-store');
}

// ─── Vercel handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  setCorsHeaders(res, origin);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Client IP — Vercel populates x-forwarded-for
  const clientIP =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  if (isRateLimited(clientIP)) {
    console.warn(`[create-payment] Rate limit hit | IP=${clientIP}`);
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Trop de requêtes. Veuillez patienter 1 minute.',
    });
  }

  // Body — Vercel auto-parses JSON when Content-Type: application/json
  // Guard against missing / malformed body just in case
  const body = req.body && typeof req.body === 'object'
    ? req.body
    : (() => {
        try { return JSON.parse(req.body || '{}'); }
        catch { return null; }
      })();

  if (!body) {
    return res.status(400).json({ error: 'Corps de requête invalide.' });
  }

  const { rooms: rawRooms, checkIn, checkOut, guests } = body;

  console.log('[create-payment] body received | ' + JSON.stringify({ rawRooms, checkIn, checkOut, guests }));

  // Server-side validation
  const errors = validateInput({ rooms: rawRooms, checkIn, checkOut, guests });
  if (errors.length > 0) {
    console.warn('[create-payment] 422 details:', errors);
    return res.status(422).json({ error: 'Données invalides.', details: errors });
  }

  const { rooms } = parseRooms(rawRooms);
  const roomLabel  = buildRoomLabel(rooms);
  const base       = PAYPAL_BASE_URL;

  console.log(
    '[create-payment] Invocation start | ' +
    `paypal_env=${IS_SANDBOX ? 'SANDBOX' : 'LIVE'} | ` +
    `IP=${clientIP} | rooms=${roomLabel} | checkIn=${checkIn} | checkOut=${checkOut} | guests=${guests} | ` +
    `base_url=${base}`
  );

  try {
    const { totalMAD, totalEUR, nights } = calculatePrice(rooms, checkIn, checkOut, guests);

    console.log(
      `[create-payment] Price computed | rooms=${roomLabel} | nights=${nights} | ` +
      `totalMAD=${totalMAD} | totalEUR=${totalEUR}`
    );

    const token          = await getPayPalAccessToken(base);
    const idempotencyKey = crypto.randomUUID();
    const orderUrl       = `${base}/v2/checkout/orders`;

    const s = rooms.find(r => r.type === 'single')?.qty ?? 0;
    const d = rooms.find(r => r.type === 'double')?.qty ?? 0;
    const t = rooms.find(r => r.type === 'triple')?.qty ?? 0;
    const customId = JSON.stringify({ s, d, t, ci: checkIn, co: checkOut, g: String(guests), m: String(totalMAD) });

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: `Tiznit Hotel — ${roomLabel} — ${guests} pers. — ${nights} nuit(s)`,
          amount: {
            currency_code: 'EUR',
            value:         totalEUR,
          },
          custom_id: customId,
        },
      ],
      application_context: {
        brand_name:          'Tiznit Hotel',
        landing_page:        'NO_PREFERENCE',
        user_action:         'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    };

    console.log(
      `[create-payment] PayPal order request -> ${orderUrl} | ` +
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

    if (!orderRes.ok) {
      let errBody;
      try   { errBody = await orderRes.json(); }
      catch { errBody = { raw: await orderRes.text() }; }

      console.error(
        '[create-payment] PayPal ORDER creation failed | ' +
        `HTTP ${orderRes.status} ${orderRes.statusText} | ` +
        `url=${orderUrl} | ` +
        `paypal_error_name=${errBody.name || 'n/a'} | ` +
        `paypal_error_message=${errBody.message || 'n/a'} | ` +
        `paypal_error_details=${JSON.stringify(errBody.details || [])} | ` +
        `full_response=${JSON.stringify(errBody)}`
      );

      const err        = new Error(
        `PayPal order creation failed (HTTP ${orderRes.status}): ` +
        `${errBody.name || ''} — ${errBody.message || JSON.stringify(errBody)}`
      );
      err.paypalStatus  = orderRes.status;
      err.paypalPayload = errBody;
      throw err;
    }

    const order = await orderRes.json();

    console.log(
      '[create-payment] PayPal order CREATED | ' +
      `id=${order.id} | ` +
      `status=${order.status} | ` +
      `intent=${order.intent} | ` +
      `currency=${order.purchase_units?.[0]?.amount?.currency_code} | ` +
      `value=${order.purchase_units?.[0]?.amount?.value} | ` +
      `links=${JSON.stringify((order.links || []).map(l => l.rel + ':' + l.href))}`
    );

    return res.status(200).json({
      orderID:  order.id,
      totalMAD,
      totalEUR,
      nights,
    });

  } catch (err) {
    console.error(
      '[create-payment] FATAL | ' +
      `message=${err.message} | ` +
      `paypalStatus=${err.paypalStatus || 'n/a'} | ` +
      `paypalPayload=${err.paypalPayload ? JSON.stringify(err.paypalPayload) : 'n/a'} | ` +
      `stack=${err.stack || 'n/a'}`
    );

    // Return the actual PayPal error to the browser so debugging is instant
    const statusCode = err.paypalStatus ? 502 : 500;
    return res.status(statusCode).json({
      error: err.message,
      ...(err.paypalStatus  && { paypalHttpStatus: err.paypalStatus }),
      ...(err.paypalPayload && { paypalError:      err.paypalPayload }),
    });
  }
};
