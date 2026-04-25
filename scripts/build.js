#!/usr/bin/env node
/**
 * scripts/build.js  —  Build-time environment injection
 * -------------------------------------------------------
 * WHY THIS EXISTS
 * Netlify injects process.env only into serverless Functions, never into
 * static HTML files.  The PayPal JS SDK requires a client-id in a <script>
 * tag — it cannot be fetched at runtime from an env var.
 *
 * This script runs as the Netlify build command (see netlify.toml).
 * It reads PAYPAL_CLIENT_ID from the environment and writes it directly
 * into public/index.html before Netlify deploys the file.
 *
 * HOW TO USE
 * 1. Set PAYPAL_CLIENT_ID in Netlify:
 *      Site configuration → Environment variables → Add variable
 *      Key:   PAYPAL_CLIENT_ID
 *      Value: <your LIVE PayPal client-id from developer.paypal.com>
 * 2. Trigger a new deploy (git push or manual deploy).
 *    Netlify will run this script, stamp the live client-id in, then publish.
 *
 * LOCAL DEVELOPMENT
 * Create a .env file (never commit it) or run:
 *   PAYPAL_CLIENT_ID=<id> node scripts/build.js
 */

'use strict';

const fs          = require('fs');
const path        = require('path');

// ── Load .env for local runs (ignored if file doesn't exist) ──────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"#\r\n]*)"?/);
      if (match) process.env[match[1]] = match[2].trim();
    });
}

// ── Mode detection ────────────────────────────────────────────────────────
const PAYPAL_ENV   = (process.env.PAYPAL_ENV || 'live').toLowerCase();
const isSandbox    = PAYPAL_ENV === 'sandbox';
const IS_TEST_MODE = (process.env.TEST_PAYMENT_MODE || '').toLowerCase() === 'true';
const PLACEHOLDER      = '__PAYPAL_CLIENT_ID__';
const TEST_PLACEHOLDER = '__TEST_PAYMENT_MODE__';

console.log('[build] 🌍  PayPal env   : ' + (isSandbox ? 'SANDBOX' : 'LIVE'));
if (IS_TEST_MODE) {
  console.log('[build] ⚠️   TEST_PAYMENT_MODE=true — fake button active, no real PayPal.');
  console.log('[build]     DO NOT use this in production.');
}

// ── Read index.html ───────────────────────────────────────────────────────
const htmlPath = path.join(__dirname, '..', 'public', 'index.html');

if (!fs.existsSync(htmlPath)) {
  console.error('[build] ❌  public/index.html not found at: ' + htmlPath);
  process.exit(1);
}

let html = fs.readFileSync(htmlPath, 'utf8');

// ── Inject TEST_PAYMENT_MODE ──────────────────────────────────────────────
if (html.includes(TEST_PLACEHOLDER)) {
  html = html.replace(TEST_PLACEHOLDER, IS_TEST_MODE ? 'true' : 'false');
  console.log('[build] ✅  TEST_PAYMENT_MODE injected : ' + (IS_TEST_MODE ? 'true' : 'false'));
} else {
  console.warn('[build] ⚠️   Placeholder ' + TEST_PLACEHOLDER + ' not found — already injected?');
}

// ── In test mode: inject dummy client-id (PayPal SDK not used) ────────────
if (IS_TEST_MODE) {
  if (html.includes(PLACEHOLDER)) {
    html = html.replace(PLACEHOLDER, 'test-mode-disabled');
  }
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('[build] ✅  Test mode build complete — dummy client-id set.');
  process.exit(0);
}

// ── Normal mode: validate and inject real PayPal client-id ────────────────
if (!html.includes(PLACEHOLDER)) {
  console.warn('[build] ⚠️   Placeholder ' + PLACEHOLDER + ' not found — already injected?');
  console.warn('[build]     Skipping injection. Verify the deployed index.html manually.');
  process.exit(0);
}

let clientId;
if (isSandbox) {
  clientId = (process.env.PAYPAL_SANDBOX_CLIENT_ID || '').trim();
  if (!clientId) {
    console.error('[build] ❌  Sandbox mode — PAYPAL_SANDBOX_CLIENT_ID is not set.');
    console.error('[build]     → Add it in Vercel: Project Settings → Environment Variables');
    process.exit(1);
  }
  if (/\s/.test(clientId)) {
    console.error('[build] ❌  PAYPAL_SANDBOX_CLIENT_ID contains whitespace.');
    process.exit(1);
  }
} else {
  clientId = (process.env.PAYPAL_CLIENT_ID || process.env.ID_CLIENT_PAYPAL || '').trim();
  if (!clientId) {
    console.error('[build] ❌  Live mode — PAYPAL_CLIENT_ID is not set.');
    console.error('[build]     → Add it in Vercel: Project Settings → Environment Variables');
    process.exit(1);
  }
  if (/\s/.test(clientId)) {
    console.error('[build] ❌  PAYPAL_CLIENT_ID contains whitespace.');
    process.exit(1);
  }
  // Extra guard in live mode: warn if key looks like a sandbox key
  if (clientId.toLowerCase().startsWith('sb-') || clientId.toLowerCase().includes('sandbox')) {
    console.error('[build] ❌  Live mode: PAYPAL_CLIENT_ID looks like a sandbox key.');
    console.error('[build]     Use developer.paypal.com → My Apps → Live tab.');
    process.exit(1);
  }
}

// ── Inject ────────────────────────────────────────────────────────────────
html = html.replace(PLACEHOLDER, clientId);
fs.writeFileSync(htmlPath, html, 'utf8');

console.log('[build] ✅  Client-id injected into public/index.html');
console.log('[build]     paypal_env    : ' + (isSandbox ? 'SANDBOX' : 'LIVE'));
console.log('[build]     client-id len : ' + clientId.length + ' chars');
console.log('[build]     first 8 chars : ' + clientId.substring(0, 8) + '…  (rest redacted)');
