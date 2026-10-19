'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { MongoClient } = require('mongodb');

const PORT = Number(process.env.PORT) || 10000;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://avioc-cinema.web.app').replace(/\/$/, '');
const API_BASE_URL = (process.env.API_BASE_URL || 'https://avioc-cinema-backend.onrender.com').replace(/\/$/, '');
const ALLOWED_ORIGINS = new Set([
  FRONTEND_URL,
  'https://avioc-cinema.web.app',
  'https://avioc-cinema.firebaseapp.com',
  ...(process.env.EXTRA_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim().replace(/\/$/, ''))
].filter(Boolean));
const TOKEN_SECRET = process.env.TOKEN_SECRET || process.env.SESSION_SECRET || 'avioc-cinema-secure-jwt-token-secret-fallback-minimum-32-chars';
const LIVEPAY_URL = 'https://livepay.me/api';
const PLAN_LIST = [
  { id: 'day-1', days: 1, amountUgx: 1000 },
  { id: 'days-3', days: 3, amountUgx: 2000 },
  { id: 'days-7', days: 7, amountUgx: 5000 },
  { id: 'days-14', days: 14, amountUgx: 10000 },
  { id: 'days-30', days: 30, amountUgx: 20000 },
  { id: 'days-60', days: 60, amountUgx: 38000 },
  { id: 'days-90', days: 90, amountUgx: 55000 }
];
const CARD_PRICES_USD = { 'days-14': 3.8, 'days-30': 6.0, 'days-60': 9.0, 'days-90': 11.5 };

let mongoClient;
let db;
let users;
let payments;
let subscriptions;
let webhookEvents;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.headers.origin && (ALLOWED_ORIGINS.size === 0 || ALLOWED_ORIGINS.has('*') || ALLOWED_ORIGINS.has(req.headers.origin.replace(/\/$/, '')))) {
    res.set('Access-Control-Allow-Origin', req.headers.origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const throttleBuckets = new Map();
function throttle({ windowMs = 15 * 60 * 1000, limit = 20 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let bucket = throttleBuckets.get(key);
    if (!bucket || bucket.until <= now) bucket = { count: 0, until: now + windowMs };
    bucket.count += 1;
    throttleBuckets.set(key, bucket);
    if (throttleBuckets.size > 5000) {
      for (const [entry, value] of throttleBuckets) if (value.until <= now) throttleBuckets.delete(entry);
    }
    if (bucket.count > limit) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    next();
  };
}

function fail(res, status, message) { return res.status(status).json({ error: message }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeEqualHex(left, right) {
  if (!/^[a-f0-9]+$/i.test(left || '') || !/^[a-f0-9]+$/i.test(right || '')) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function validEmail(email) { return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash, encoded: `scrypt$${salt}$${hash}` };
}
function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function signJwt(user) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14 })).toString('base64url');
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  return `${data}.${signature}`;
}
function readJwt(token) {
  const [header, payload, signature, extra] = String(token || '').split('.');
  if (!header || !payload || !signature || extra) return null;
  const data = `${header}.${payload}`;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch { return null; }
}
function requireAuth(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const claims = match && readJwt(match[1]);
  if (!claims) return fail(res, 401, 'Please sign in again.');
  req.auth = claims;
  next();
}
async function requireVerifiedUser(req, res, next) {
  try {
    const user = await users.findOne({ id: req.auth.sub }, { projection: { id: 1, email: 1, display_name: 1, email_verified_at: 1, avatar: 1 } });
    if (!user) return fail(res, 401, 'Account not found.');
    if (!user.email_verified_at && (process.env.RESEND_API_KEY && process.env.EMAIL_FROM)) return fail(res, 403, 'Verify your email before continuing.');
    req.user = user;
    next();
  } catch (error) { next(error); }
}
function userOnly(req, res, next) { return requireAuth(req, res, () => requireVerifiedUser(req, res, next)); }
function publicError(error) {
  console.error(error);
  return { error: 'Something went wrong. Please try again.' };
}

async function sendEmail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error('Email service is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, text })
  });
  if (!response.ok) throw new Error(`Email provider rejected request (${response.status})`);
}

async function ensureSchema() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  mongoClient = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await mongoClient.connect();
  db = mongoClient.db(process.env.MONGODB_DB || undefined);
  users = db.collection('users');
  payments = db.collection('payments');
  subscriptions = db.collection('subscriptions');
  webhookEvents = db.collection('webhook_events');
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    users.createIndex({ verify_token_hash: 1 }, { sparse: true }),
    users.createIndex({ reset_token_hash: 1 }, { sparse: true }),
    payments.createIndex({ reference: 1 }, { unique: true }),
    payments.createIndex({ user_id: 1, created_at: -1 }),
    payments.createIndex({ provider_internal_reference: 1 }, { unique: true, partialFilterExpression: { provider_internal_reference: { $type: 'string' } } }),
    subscriptions.createIndex({ user_id: 1 }, { unique: true }),
    webhookEvents.createIndex({ event_key: 1 }, { unique: true })
  ]);
}

app.get('/healthz', async (_req, res) => {
  try { await db.command({ ping: 1 }); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.get('/api/plans', (_req, res) => {
  res.json({ currency: 'UGX', plans: PLAN_LIST });
});

app.post('/api/auth/register', throttle({ limit: 15 }), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const displayName = String(req.body?.displayName || '').trim().slice(0, 80);
  const password = String(req.body?.password || '');
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
  if (displayName.length < 2) return fail(res, 400, 'Enter your name.');
  if (password.length < 10 || password.length > 200) return fail(res, 400, 'Password must be at least 10 characters.');

  const hasEmailService = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
  const verifyToken = randomToken();
  const passwordData = hashPassword(password);
  const id = crypto.randomUUID();
  try {
    await users.insertOne({
      id,
      email,
      display_name: displayName,
      password_hash: passwordData.encoded,
      verify_token_hash: hasEmailService ? sha256(verifyToken) : null,
      verify_expires_at: hasEmailService ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
      email_verified_at: hasEmailService ? null : new Date(),
      reset_token_hash: null,
      reset_expires_at: null,
      created_at: new Date(),
      updated_at: new Date()
    });

    if (hasEmailService) {
      const verifyUrl = `${API_BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`;
      try {
        await sendEmail({
          to: email,
          subject: 'Verify your Avioc Cinema email',
          text: `Hello ${displayName}, verify your email within 24 hours: ${verifyUrl}`,
          html: `<p>Hello ${escapeHtml(displayName)},</p><p>Confirm this email address to activate your Avioc Cinema account.</p><p><a href="${verifyUrl}">Verify my email</a></p><p>This link expires in 24 hours.</p>`
        });
        return res.status(201).json({ message: 'Check your email for the verification link.' });
      } catch (mailError) {
        await users.deleteOne({ id });
        throw mailError;
      }
    }

    const token = signJwt({ id, email, display_name: displayName });
    res.status(201).json({
      token,
      user: { id, email, displayName, avatar: null },
      subscriptionExpiresAt: null,
      message: 'Account created successfully.'
    });
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, 'An account already uses this email.');
    res.status(500).json(publicError(error));
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

app.get('/api/auth/verify-email', throttle({ limit: 20 }), async (req, res) => {
  const token = String(req.query.token || '');
  if (token.length < 32 || token.length > 128) return res.status(400).send('This verification link is invalid or expired.');
  try {
    const result = await users.updateOne(
      { verify_token_hash: sha256(token), verify_expires_at: { $gt: new Date() } },
      { $set: { email_verified_at: new Date(), updated_at: new Date() }, $unset: { verify_token_hash: '', verify_expires_at: '' } }
    );
    if (!result.modifiedCount) return res.status(400).send('This verification link is invalid or expired.');
    res.type('html').send('<!doctype html><html><meta name="viewport" content="width=device-width"><title>Email verified</title><body style="font:16px system-ui;max-width:36rem;margin:12vh auto;padding:24px;background:#111;color:#fff"><h1>Email verified</h1><p>Your Avioc Cinema account is confirmed. Return to the app and sign in.</p></body></html>');
  } catch (error) { res.status(500).send(publicError(error).error); }
});

app.post('/api/auth/login', throttle({ limit: 15 }), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  try {
    const user = await users.findOne({ email });
    if (!user || !verifyPassword(password, user.password_hash)) return fail(res, 401, 'Email or password is incorrect.');
    if (!user.email_verified_at && (process.env.RESEND_API_KEY && process.env.EMAIL_FROM)) return fail(res, 403, 'Verify your email before signing in.');
    const subscription = await subscriptions.findOne({ user_id: user.id });
    res.json({
      token: signJwt(user),
      user: { id: user.id, email: user.email, displayName: user.display_name, avatar: user.avatar || null },
      subscriptionExpiresAt: subscription?.expires_at || null
    });
  } catch (error) { res.status(500).json(publicError(error)); }
});

app.post('/api/auth/request-password-reset', throttle({ limit: 5 }), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
  const newPassword = String(req.body?.newPassword || '');
  const generic = { message: 'If that account exists, a reset link will be sent.' };
  try {
    const user = await users.findOne({ email });
    if (!user) return res.json(generic);
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !API_BASE_URL) {
      if (newPassword) {
        if (newPassword.length < 10 || newPassword.length > 200) return fail(res, 400, 'Password must be at least 10 characters.');
        const passwordHash = hashPassword(newPassword).encoded;
        await users.updateOne({ id: user.id }, { $set: { password_hash: passwordHash, updated_at: new Date() } });
        return res.json({ message: 'Password updated successfully! You can now sign in.' });
      }
      return fail(res, 400, 'Email service is not configured. Please sign in to change your password, or provide a new password.');
    }
    const token = randomToken();
    await users.updateOne({ id: user.id }, { $set: { reset_token_hash: sha256(token), reset_expires_at: new Date(Date.now() + 60 * 60 * 1000), updated_at: new Date() } });
    const url = `${API_BASE_URL}/api/auth/reset-password?token=${encodeURIComponent(token)}`;
    await sendEmail({ to: email, subject: 'Reset your Avioc Cinema password', text: `Reset your password within one hour: ${url}`, html: `<p>Hello ${escapeHtml(user.display_name)},</p><p><a href="${url}">Reset your password</a></p><p>This link expires in one hour.</p>` });
    res.json(generic);
  } catch (error) { res.status(500).json(publicError(error)); }
});

app.get('/api/auth/reset-password', throttle({ limit: 20 }), (req, res) => {
  const token = String(req.query.token || '');
  if (token.length < 32 || token.length > 128) return res.status(400).send('This reset link is invalid or expired.');
  res.type('html').send(`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Reset password</title><body style="font:16px system-ui;max-width:28rem;margin:12vh auto;padding:24px;background:#111;color:#fff"><h1>Choose a new password</h1><form id="form"><label>New password<br><input id="password" type="password" minlength="10" maxlength="200" required autocomplete="new-password" style="box-sizing:border-box;width:100%;padding:12px;margin:8px 0 16px"></label><button style="padding:12px 18px">Update password</button></form><p id="message" role="status"></p><script>document.getElementById('form').addEventListener('submit',async e=>{e.preventDefault();const message=document.getElementById('message');try{const r=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)},password:document.getElementById('password').value})});const d=await r.json();message.textContent=d.message||d.error||'Request failed';}catch{message.textContent='Could not reset the password. Please try again.';}})</script></body></html>`);
});

app.post('/api/auth/reset-password', throttle({ limit: 8 }), async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (token.length < 32 || token.length > 128) return fail(res, 400, 'This reset link is invalid or expired.');
  if (password.length < 10 || password.length > 200) return fail(res, 400, 'Password must be at least 10 characters.');
  const passwordHash = hashPassword(password).encoded;
  try {
    const result = await users.updateOne(
      { reset_token_hash: sha256(token), reset_expires_at: { $gt: new Date() } },
      { $set: { password_hash: passwordHash, updated_at: new Date() }, $unset: { reset_token_hash: '', reset_expires_at: '' } }
    );
    if (!result.modifiedCount) return fail(res, 400, 'This reset link is invalid or expired.');
    res.json({ message: 'Password updated. You can now sign in.' });
  } catch (error) { res.status(500).json(publicError(error)); }
});

app.post('/api/auth/change-password', userOnly, throttle({ limit: 10 }), async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 10 || newPassword.length > 200) {
    return fail(res, 400, 'New password must be at least 10 characters.');
  }
  try {
    const user = await users.findOne({ id: req.user.id });
    if (!user) return fail(res, 404, 'Account not found.');
    if (user.password_hash) {
      if (!currentPassword) {
        return fail(res, 400, 'Please enter your current password.');
      }
      if (!verifyPassword(currentPassword, user.password_hash)) {
        return fail(res, 400, 'Current password is incorrect.');
      }
    }
    const passwordHash = hashPassword(newPassword).encoded;
    await users.updateOne(
      { id: req.user.id },
      { $set: { password_hash: passwordHash, updated_at: new Date() } }
    );
    res.json({ message: 'Password updated successfully!' });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/auth/update-profile', userOnly, async (req, res) => {
  const displayName = String(req.body?.displayName || '').trim().slice(0, 80);
  const avatar = String(req.body?.avatar || '').trim().slice(0, 500);
  const update = { updated_at: new Date() };
  if (displayName && displayName.length >= 2) update.display_name = displayName;
  if (avatar) update.avatar = avatar;
  try {
    await users.updateOne({ id: req.user.id }, { $set: update });
    const updated = await users.findOne({ id: req.user.id });
    res.json({
      message: 'Profile updated!',
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.display_name,
        avatar: updated.avatar || null
      }
    });
  } catch (error) { res.status(500).json(publicError(error)); }
});

async function confirmAtLivePay(reference, currency = 'UGX') {
  const accountNumber = (process.env.LIVEPAY_ACCOUNT_NUMBER || '').trim();
  const apiKey = (process.env.LIVEPAY_API_KEY || '').trim();
  if (!accountNumber || !apiKey) throw new Error('LivePay credentials not configured');
  const url = new URL(`${LIVEPAY_URL}/transaction-status`);
  url.search = new URLSearchParams({ accountNumber, currency: (currency || 'UGX').toUpperCase(), reference }).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`LivePay status lookup failed (${response.status})`);
  return response.json();
}

async function activatePaymentSuccess(payment, livepayData = {}) {
  if (!payment) return false;
  const plan = PLAN_LIST.find((item) => item.id === payment.plan_id);
  if (!plan) return false;
  const now = new Date();
  await payments.updateOne(
    { id: payment.id },
    {
      $set: {
        status: 'success',
        provider_transaction_id: String(livepayData.provider_transaction_id || '').slice(0, 200),
        provider_name: String(livepayData.provider || payment.payment_method).slice(0, 40),
        completed_at: now
      }
    }
  );
  const current = await subscriptions.findOne({ user_id: payment.user_id });
  const startAt = current?.expires_at && new Date(current.expires_at) > now ? new Date(current.expires_at) : now;
  const expiry = new Date(startAt.getTime() + plan.days * 24 * 60 * 60 * 1000);
  await subscriptions.updateOne(
    { user_id: payment.user_id },
    { $set: { expires_at: expiry, updated_at: now }, $setOnInsert: { user_id: payment.user_id } },
    { upsert: true }
  );
  console.log(`[PASS ACTIVATED] User ${payment.user_id} pass ${plan.days} days until ${expiry.toISOString()}`);
  return true;
}

app.get('/api/me', userOnly, async (req, res) => {
  try {
    let subscription = await subscriptions.findOne({ user_id: req.user.id });
    let expiry = subscription?.expires_at || null;
    let isActive = Boolean(expiry && new Date(expiry) > new Date());

    if (!isActive) {
      const recentPayments = await payments.find({ user_id: req.user.id, status: { $ne: 'success' } }).sort({ created_at: -1 }).limit(5).toArray();
      for (const p of recentPayments) {
        try {
          const check = await confirmAtLivePay(p.reference, p.currency);
          console.log(`LivePay status check for ${p.reference}:`, check);
          const s = String(check?.status || '').toLowerCase();
          if (s === 'success' || s === 'successful' || s === 'completed') {
            await activatePaymentSuccess(p, check);
            subscription = await subscriptions.findOne({ user_id: req.user.id });
            expiry = subscription?.expires_at || null;
            isActive = true;
            break;
          } else if (['failed', 'failure', 'cancelled', 'canceled', 'expired'].includes(s)) {
            await payments.updateOne({ id: p.id }, { $set: { status: 'failed', provider_message: check.message || check.status } });
          }
        } catch (err) {
          console.warn(`Could not verify pending payment ${p.reference} at LivePay:`, err.message);
        }
      }
    }

    res.json({
      user: { id: req.user.id, email: req.user.email, displayName: req.user.display_name, avatar: req.user.avatar || null },
      subscriptionExpiresAt: expiry,
      active: isActive
    });
  } catch (error) { res.status(500).json(publicError(error)); }
});

app.get('/api/prices/card', async (_req, res) => {
  const plans = PLAN_LIST.filter((plan) => CARD_PRICES_USD[plan.id] !== undefined).map((plan) => ({
    id: plan.id,
    amountUgx: plan.amountUgx,
    amountUsd: CARD_PRICES_USD[plan.id]
  }));
  res.json({ currency: 'USD', plans });
});

function newReference() { return `AV${crypto.randomBytes(13).toString('hex').toUpperCase()}`; }

app.post('/api/payments', userOnly, throttle({ limit: 10 }), async (req, res) => {
  const plan = PLAN_LIST.find((item) => item.id === String(req.body?.planId || ''));
  const method = String(req.body?.method || '');
  if (!plan) return fail(res, 400, 'Choose a valid subscription plan.');
  if (!['mobile_money', 'card'].includes(method)) return fail(res, 400, 'Choose mobile money or card.');
  const livepayKey = (process.env.LIVEPAY_API_KEY || '').trim();
  const livepayAccount = (process.env.LIVEPAY_ACCOUNT_NUMBER || '').trim();
  if (!livepayKey || !livepayAccount) return fail(res, 503, 'Payment service is not configured yet.');

  let amount = plan.amountUgx;
  let currency = 'UGX';
  let exchangeRate = null;
  let phoneNumber = null;
  let network = null;
  let livepayPath = '/collect-money';
  let livepayBody;

  if (method === 'mobile_money') {
    phoneNumber = String(req.body?.phoneNumber || '').trim().replace(/[\s()-]/g, '');
    network = String(req.body?.network || '').toUpperCase();
    if (!/^\+?[0-9]{9,15}$/.test(phoneNumber)) return fail(res, 400, 'Enter a valid mobile money phone number.');
    if (!['MTN', 'AIRTEL'].includes(network)) return fail(res, 400, 'Choose MTN or Airtel.');
    livepayBody = { accountNumber: livepayAccount, phoneNumber, amount, currency, reference: '', description: `Avioc Cinema ${plan.days}-day pass` };
  } else {
    const name = String(req.body?.name || req.user.display_name).trim().slice(0, 100);
    const cardPrice = CARD_PRICES_USD[plan.id];
    if (cardPrice === undefined) return fail(res, 400, 'That pass is not available by card. Choose a 14-day or 30-day pass, or use mobile money.');
    currency = 'USD';
    amount = cardPrice;
    exchangeRate = null;
    if (amount < 1) return fail(res, 400, 'LivePay card checkout has a USD 1.00 minimum. Choose a longer pass or use MTN/Airtel mobile money.');
    livepayPath = '/card-collection';
    livepayBody = { accountNumber: livepayAccount, amount, currency, reference: '', email: req.user.email, name, description: `Avioc Cinema ${plan.days}-day pass`, return_url: `${FRONTEND_URL}/?payment=pending` };
  }

  const reference = newReference();
  livepayBody.reference = reference;
  if (method === 'card') {
    const returnUrl = new URL(FRONTEND_URL);
    returnUrl.searchParams.set('payment', 'pending');
    returnUrl.searchParams.set('reference', reference);
    livepayBody.return_url = returnUrl.toString();
  }
  const paymentId = crypto.randomUUID();
  await payments.insertOne({ id: paymentId, user_id: req.user.id, user_email: req.user.email, email: req.user.email, user_name: req.user.display_name, display_name: req.user.display_name, reference, plan_id: plan.id,
    amount_ugx: plan.amountUgx, payment_method: method, currency, amount, exchange_rate: exchangeRate,
    phone_number: phoneNumber, network, status: 'pending', created_at: new Date(), completed_at: null });

  try {
    const providerResponse = await fetch(`${LIVEPAY_URL}${livepayPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${livepayKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(livepayBody),
      signal: AbortSignal.timeout(20000)
    });
    const data = await providerResponse.json().catch(() => ({}));
    console.log('LivePay API status:', providerResponse.status, 'body:', JSON.stringify(data), 'sent:', JSON.stringify(livepayBody));
    if (!providerResponse.ok || data.success !== true) {
      const errorMsg = data.message || data.error || `LivePay returned HTTP ${providerResponse.status}`;
      await payments.updateOne({ id: paymentId }, { $set: { status: 'failed', provider_message: String(errorMsg).slice(0, 500) } });
      return fail(res, 502, errorMsg);
    }
    const checkoutUrl = method === 'card' ? livepayCheckoutUrl(data.checkout_url) : null;
    if (method === 'card' && !checkoutUrl) {
      await payments.updateOne({ id: paymentId }, { $set: { status: 'failed', provider_message: 'LivePay did not return an approved checkout URL' } });
      return fail(res, 502, 'LivePay did not return a valid checkout link. Please try again.');
    }
    await payments.updateOne({ id: paymentId }, { $set: { provider_internal_reference: data.internal_reference || null,
      provider_name: data.network || network || method, provider_message: String(data.message || '').slice(0, 500) } });
    res.status(201).json({
      paymentId,
      reference,
      status: 'pending',
      method,
      amount,
      currency,
      amountUgx: plan.amountUgx,
      exchangeRate,
      checkoutUrl,
      message: method === 'card' ? 'Continue to LivePay to complete your card payment.' : 'Approve the payment prompt on your phone.'
    });
  } catch (error) {
    console.error('LivePay fetch error:', error);
    await payments.updateOne({ id: paymentId, status: 'pending' }, { $set: { status: 'failed', provider_message: String(error.message || 'LivePay request failed').slice(0, 500) } }).catch(() => {});
    res.status(502).json({ error: error.message || 'LivePay could not be reached. Please try again.' });
  }
});

app.get('/api/payments/last-status', userOnly, async (req, res) => {
  try {
    const payment = await payments.findOne({ user_id: req.user.id }, { sort: { created_at: -1 } });
    if (!payment) return fail(res, 404, 'No payments recorded.');
    res.json({
      status: payment.status,
      providerMessage: payment.provider_message,
      reference: payment.reference,
      amount: payment.amount,
      currency: payment.currency,
      phoneNumber: payment.phone_number,
      network: payment.network,
      createdAt: payment.created_at
    });
  } catch (error) { res.status(500).json(publicError(error)); }
});

function livepayCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'livepay.me' ? url.toString() : null;
  } catch { return null; }
}

app.get('/api/payments/:reference', userOnly, async (req, res) => {
  try {
    let payment = await payments.findOne({ reference: req.params.reference, user_id: req.user.id });
    if (!payment) return fail(res, 404, 'Payment not found.');

    if (payment.status === 'pending') {
      try {
        const check = await confirmAtLivePay(payment.reference, payment.currency);
        console.log(`Polling status check for ${payment.reference}:`, check);
        if (String(check?.status || '').toLowerCase() === 'success') {
          await activatePaymentSuccess(payment, check);
          payment.status = 'success';
        } else if (['failed', 'failure', 'cancelled', 'canceled', 'expired'].includes(String(check?.status || '').toLowerCase())) {
          await payments.updateOne({ id: payment.id }, { $set: { status: 'failed', provider_message: check.message || check.status } });
          payment.status = 'failed';
        }
      } catch (err) {
        console.warn(`Polling status check error for ${payment.reference}:`, err.message);
      }
    }

    res.json({
      payment: {
        reference: payment.reference,
        plan_id: payment.plan_id,
        amount_ugx: payment.amount_ugx,
        payment_method: payment.payment_method,
        currency: payment.currency,
        amount: payment.amount,
        status: payment.status,
        created_at: payment.created_at,
        completed_at: payment.completed_at
      },
      status: payment.status
    });
  } catch (error) { res.status(500).json(publicError(error)); }
});

function verifyLivePaySignature(payload, header) {
  const secret = process.env.LIVEPAY_WEBHOOK_SECRET;
  const webhookUrl = process.env.LIVEPAY_WEBHOOK_URL;
  if (!secret || !webhookUrl || !header) return false;
  const match = /^t=(\d+),v=([a-f0-9]+)$/i.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 5 * 60) return false;
  const fields = {
    customer_reference: String(payload.customer_reference || ''),
    internal_reference: String(payload.internal_reference || ''),
    status: String(payload.status || '')
  };
  if (!fields.customer_reference || !fields.internal_reference || !fields.status) return false;
  const canonical = Object.keys(fields).sort().map((key) => `${key}${fields[key]}`).join('');
  const expected = crypto.createHmac('sha256', secret).update(`${webhookUrl}${match[1]}${canonical}`).digest('hex');
  return safeEqualHex(match[2], expected);
}

app.post('/api/payments/livepay-webhook', throttle({ limit: 120 }), async (req, res) => {
  const payload = req.body || {};
  console.log('Received LivePay webhook payload:', JSON.stringify(payload), 'headers:', JSON.stringify(req.headers));

  const reference = String(payload.customer_reference || payload.reference || '');
  const status = String(payload.status || '').toLowerCase();
  if (!reference) return fail(res, 400, 'Missing reference in webhook.');

  const payment = await payments.findOne({ reference });
  if (!payment) return fail(res, 404, 'Payment reference not found.');

  let verifiedPayment = null;
  if (status === 'success') {
    try {
      verifiedPayment = await confirmAtLivePay(reference, String(payload.currency || payment.currency).toUpperCase());
    } catch (error) {
      console.error('Could not confirm LivePay webhook transaction:', error.message);
    }
  }

  const isVerified = (verifiedPayment && String(verifiedPayment.status || '').toLowerCase() === 'success') || status === 'success';

  if (isVerified) {
    await activatePaymentSuccess(payment, verifiedPayment || payload);
  } else if (['failed', 'failure', 'cancelled', 'canceled', 'expired'].includes(status)) {
    await payments.updateOne({ id: payment.id, status: 'pending' }, { $set: { status: 'failed', provider_message: String(payload.message || payload.status).slice(0, 500) } });
  }

  res.sendStatus(200);
});

app.use((req, res) => fail(res, 404, 'Route not found.'));
app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && 'body' in error) return fail(res, 400, 'Request body must be valid JSON.');
  res.status(500).json(publicError(error));
});

async function start() {
  const missing = ['MONGODB_URI', 'TOKEN_SECRET', 'FRONTEND_URL', 'API_BASE_URL', 'LIVEPAY_API_KEY', 'LIVEPAY_ACCOUNT_NUMBER', 'LIVEPAY_WEBHOOK_SECRET', 'LIVEPAY_WEBHOOK_URL', 'EMAIL_FROM', 'RESEND_API_KEY'].filter((name) => !process.env[name]);
  if (missing.length) console.warn(`Configuration still needed: ${missing.join(', ')}`);
  if (TOKEN_SECRET.length < 32) throw new Error('TOKEN_SECRET must contain at least 32 characters.');
  if (API_BASE_URL && !API_BASE_URL.startsWith('https://')) throw new Error('API_BASE_URL must use HTTPS.');
  if (FRONTEND_URL && !FRONTEND_URL.startsWith('https://')) throw new Error('FRONTEND_URL must use HTTPS.');
  await ensureSchema();
  app.listen(PORT, '0.0.0.0', () => console.log(`Avioc Cinema API listening on ${PORT}`));
}

start().catch((error) => { console.error('Could not start Avioc Cinema API:', error); process.exit(1); });
