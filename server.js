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
let visitors;
let analyticsEvents;
let analyticsCounters;
let userRequests;
let adminMessages;
const liveSessions = new Map();
const ADMIN_PIN = process.env.ADMIN_PIN || 'avioc2026';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin || '*';
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Admin-Key, X-Visitor-Id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Max-Age', '86400');
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
  visitors = db.collection('visitors');
  analyticsEvents = db.collection('analytics_events');
  analyticsCounters = db.collection('analytics_counters');
  userRequests = db.collection('user_requests');
  adminMessages = db.collection('admin_messages');
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    users.createIndex({ verify_token_hash: 1 }, { sparse: true }),
    users.createIndex({ reset_token_hash: 1 }, { sparse: true }),
    payments.createIndex({ reference: 1 }, { unique: true }),
    payments.createIndex({ user_id: 1, created_at: -1 }),
    payments.createIndex({ provider_internal_reference: 1 }, { unique: true, partialFilterExpression: { provider_internal_reference: { $type: 'string' } } }),
    subscriptions.createIndex({ user_id: 1 }, { unique: true }),
    webhookEvents.createIndex({ event_key: 1 }, { unique: true }),
    visitors.createIndex({ visitor_id: 1 }, { unique: true }),
    visitors.createIndex({ last_seen: -1 }),
    visitors.createIndex({ user_id: 1 }),
    analyticsEvents.createIndex({ created_at: -1 }),
    analyticsEvents.createIndex({ type: 1, created_at: -1 }),
    analyticsCounters.createIndex({ key: 1 }, { unique: true }),
    analyticsCounters.createIndex({ kind: 1, count: -1 }),
    userRequests.createIndex({ created_at: -1 }),
    adminMessages.createIndex({ target_id: 1, status: 1 }),
    adminMessages.createIndex({ created_at: -1 }),
    adminMessages.createIndex({ id: 1 }, { unique: true })
  ]);
  await backfillHistoricalAnalytics();
}

async function backfillHistoricalAnalytics() {
  try {
    const [allUsers, allSubs, allPayments] = await Promise.all([
      users.find({}).toArray(),
      subscriptions.find({}).toArray(),
      payments.find({}).toArray()
    ]);
    const subMap = new Map(allSubs.map((s) => [s.user_id, s]));
    const now = new Date();

    for (const u of allUsers) {
      const vid = `member_${u.id}`;
      const sub = subMap.get(u.id);
      const hasActive = Boolean(sub?.expires_at && new Date(sub.expires_at) > now);
      const userPay = allPayments.find((p) => p.user_id === u.id);
      const seenAt = u.last_login_at || u.updated_at || u.created_at || now;
      const dayKey = todayKeyUtc(new Date(seenAt));

      await visitors.updateOne(
        { visitor_id: vid },
        {
          $setOnInsert: {
            visitor_id: vid,
            user_id: u.id,
            user_email: u.email,
            user_name: u.display_name || u.email.split('@')[0],
            device_type: userPay?.phone_number ? 'Mobile' : 'Desktop',
            os: userPay?.phone_number ? 'Android' : 'Windows',
            browser: 'Chrome',
            is_pwa: false,
            pass_mode: hasActive ? 'VIP Pass' : '3h Free Trial',
            has_active_pass: hasActive,
            current_activity: 'Signed-In Member',
            visit_count: 1,
            watch_seconds: hasActive ? 3600 : 1200,
            first_seen: u.created_at || seenAt,
            last_seen: seenAt,
            referrer: 'Direct'
          }
        },
        { upsert: true }
      );

      await analyticsCounters.updateOne(
        { key: `daily:${dayKey}` },
        {
          $setOnInsert: {
            kind: 'daily',
            date: dayKey,
            visits: 1,
            plays: 1,
            shares: 0,
            searches: 0,
            watch_seconds: 1200,
            updated_at: now
          }
        },
        { upsert: true }
      );
    }
  } catch (err) {
    console.warn('Backfill analytics warning:', err.message);
  }
}

async function trackRequestVisitor(req, activity = 'Browsing Home', userObj = null) {
  try {
    if (!visitors) return;
    const ua = req.get('user-agent') || '';
    if (/render|health|uptime|bot|crawler|spider|curl/i.test(ua)) return;
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const rawId = req.get('x-visitor-id') || (userObj?.id ? `member_${userObj.id}` : `ip_${sha256(`${ip}|${ua}`).slice(0, 14)}`);
    const visitorId = String(rawId).slice(0, 80);
    const now = new Date();
    const today = todayKeyUtc(now);
    const uaInfo = parseUserAgentInfo(ua, false);

    let hasActivePass = false;
    if (userObj?.id && subscriptions) {
      const sub = await subscriptions.findOne({ user_id: userObj.id });
      hasActivePass = Boolean(sub?.expires_at && new Date(sub.expires_at) > now);
    }

    const prev = liveSessions.get(visitorId);
    liveSessions.set(visitorId, {
      visitorId,
      userId: userObj?.id || prev?.userId || null,
      userEmail: userObj?.email || prev?.userEmail || null,
      userName: userObj?.display_name || userObj?.displayName || prev?.userName || null,
      deviceType: prev?.deviceType || uaInfo.deviceType,
      os: prev?.os || uaInfo.os,
      browser: prev?.browser || uaInfo.browser,
      isPwa: Boolean(prev?.isPwa),
      passMode: hasActivePass ? 'VIP Pass' : (prev?.passMode || '3h Free Trial'),
      hasActivePass: hasActivePass || Boolean(prev?.hasActivePass),
      freeRemainingSec: prev?.freeRemainingSec ?? null,
      activity: prev?.activity && prev.activity !== 'Browsing Home' ? prev.activity : activity,
      itemId: prev?.itemId || null,
      itemTitle: prev?.itemTitle || null,
      itemType: prev?.itemType || null,
      vj: prev?.vj || null,
      startedAt: prev?.startedAt || now,
      lastSeen: now
    });

    const updateSet = {
      last_seen: now,
      device_type: uaInfo.deviceType,
      os: uaInfo.os,
      browser: uaInfo.browser
    };
    if (userObj?.id) updateSet.user_id = userObj.id;
    if (userObj?.email) updateSet.user_email = userObj.email;
    if (userObj?.display_name || userObj?.displayName) updateSet.user_name = userObj.display_name || userObj.displayName;
    if (hasActivePass) {
      updateSet.has_active_pass = true;
      updateSet.pass_mode = 'VIP Pass';
    }

    await visitors.updateOne(
      { visitor_id: visitorId },
      {
        $set: updateSet,
        $setOnInsert: {
          visitor_id: visitorId,
          first_seen: now,
          current_activity: activity,
          pass_mode: hasActivePass ? 'VIP Pass' : '3h Free Trial',
          has_active_pass: hasActivePass,
          visit_count: 1,
          watch_seconds: 0,
          referrer: req.get('referer') || 'Direct'
        }
      },
      { upsert: true }
    );

    if (!prev) {
      await analyticsCounters.updateOne(
        { key: `daily:${today}` },
        {
          $set: { kind: 'daily', date: today, updated_at: now },
          $inc: { visits: 1 }
        },
        { upsert: true }
      );
    }
  } catch {}
}

app.get('/healthz', async (req, res) => {
  trackRequestVisitor(req, 'Browsing Home');
  try { await db.command({ ping: 1 }); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.get('/api/plans', (req, res) => {
  trackRequestVisitor(req, 'Viewing VIP Plans');
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
    users.updateOne({ id: user.id }, { $set: { last_login_at: new Date(), updated_at: new Date() } }).catch(() => {});
    trackRequestVisitor(req, 'Signed In', user);
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

    trackRequestVisitor(req, 'Browsing Home', req.user);
    res.json({
      user: { id: req.user.id, email: req.user.email, displayName: req.user.display_name, avatar: req.user.avatar || null },
      subscriptionExpiresAt: expiry,
      active: isActive
    });
  } catch (error) { res.status(500).json(publicError(error)); }
});

app.get('/api/prices/card', async (req, res) => {
  trackRequestVisitor(req, 'Browsing Home');
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

/* ===================== Real-time Analytics & Admin API ===================== */
function todayKeyUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function parseUserAgentInfo(uaRaw = '', isTvHint = false) {
  const ua = String(uaRaw || '');
  let deviceType = 'Desktop';
  if (isTvHint || /tv|smarttv|googletv|androidtv|hbbtv|appletv|crkey|tizen|webos|bravia|hisense|aft[bms]|netcast|viera|roku|mibox|shield/i.test(ua)) {
    deviceType = 'Smart TV';
  } else if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) {
    deviceType = 'Tablet';
  } else if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) {
    deviceType = 'Mobile';
  }
  let os = 'Other';
  if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/cros/i.test(ua)) os = 'ChromeOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/samsungbrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/chrome\/|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox\/|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua) && !/chrome|crios/i.test(ua)) browser = 'Safari';

  return { deviceType, os, browser };
}

function requireAdmin(req, res, next) {
  const key = String(req.get('x-admin-key') || req.query.adminKey || req.body?.adminKey || '').trim();
  if (!key || key !== ADMIN_PIN) {
    return fail(res, 401, 'Invalid Admin PIN.');
  }
  next();
}

app.post('/api/analytics/event', throttle({ windowMs: 60 * 1000, limit: 180 }), async (req, res) => {
  try {
    const body = req.body || {};
    const visitorId = String(body.visitorId || '').trim().slice(0, 80);
    if (!visitorId) return res.status(200).json({ ok: false });

    const eventType = String(body.eventType || 'heartbeat').trim().slice(0, 40);
    const now = new Date();
    const today = todayKeyUtc(now);
    const uaInfo = parseUserAgentInfo(req.get('user-agent') || body.ua || '', Boolean(body.isTv));
    const deviceType = String(body.deviceType || uaInfo.deviceType).slice(0, 30);
    const os = String(body.os || uaInfo.os).slice(0, 30);
    const browser = String(body.browser || uaInfo.browser).slice(0, 30);
    const isPwa = Boolean(body.isPwa);

    const userId = body.userId ? String(body.userId).slice(0, 80) : null;
    const userEmail = body.userEmail ? String(body.userEmail).trim().toLowerCase().slice(0, 200) : null;
    const userName = body.userName ? String(body.userName).trim().slice(0, 80) : null;
    const passMode = String(body.passMode || '3h Free Trial').slice(0, 40);
    const hasActivePass = Boolean(body.hasActivePass);
    const freeRemainingSec = Number.isFinite(Number(body.freeRemainingSec)) ? Number(body.freeRemainingSec) : null;

    const activity = String(body.activity || 'Browsing Home').slice(0, 140);
    const itemId = body.itemId ? String(body.itemId).slice(0, 100) : null;
    const itemTitle = body.itemTitle ? String(body.itemTitle).slice(0, 160) : null;
    const itemType = body.itemType ? String(body.itemType).slice(0, 30) : null;
    const vj = body.vj ? String(body.vj).slice(0, 60) : null;
    const poster = body.poster ? String(body.poster).slice(0, 400) : null;
    const query = body.query ? String(body.query).trim().slice(0, 120) : null;
    const resultsCount = Number.isFinite(Number(body.resultsCount)) ? Number(body.resultsCount) : null;
    const watchSec = Math.max(0, Math.min(120, Number(body.watchSec) || 0));
    const referrer = body.referrer ? String(body.referrer).slice(0, 300) : null;

    // Update live in-memory session
    const prevSession = liveSessions.get(visitorId);
    liveSessions.set(visitorId, {
      visitorId,
      userId,
      userEmail,
      userName,
      deviceType,
      os,
      browser,
      isPwa,
      passMode,
      hasActivePass,
      freeRemainingSec,
      activity,
      itemId,
      itemTitle,
      itemType,
      vj,
      startedAt: prevSession?.startedAt || now,
      lastSeen: now
    });
    if (liveSessions.size > 2000) {
      const cutoff = Date.now() - 2 * 60 * 1000;
      for (const [k, v] of liveSessions) {
        if (new Date(v.lastSeen).getTime() < cutoff) liveSessions.delete(k);
      }
    }

    // Update persistent visitor document
    const visitorSet = {
      last_seen: now,
      device_type: deviceType,
      os,
      browser,
      is_pwa: isPwa,
      pass_mode: passMode,
      has_active_pass: hasActivePass,
      current_activity: activity,
      current_item_id: itemId,
      current_item_title: itemTitle,
      current_item_type: itemType,
      current_vj: vj
    };
    if (userId) visitorSet.user_id = userId;
    if (userEmail) visitorSet.user_email = userEmail;
    if (userName) visitorSet.user_name = userName;
    if (freeRemainingSec !== null) visitorSet.free_remaining_sec = freeRemainingSec;

    const visitorInc = {};
    if (eventType === 'visit') visitorInc.visit_count = 1;
    if (watchSec > 0) visitorInc.watch_seconds = watchSec;
    if (eventType === 'share') visitorInc.share_count = 1;
    if (eventType === 'search') visitorInc.search_count = 1;
    if (eventType === 'play') visitorInc.play_count = 1;

    const visitorUpdate = {
      $set: visitorSet,
      $setOnInsert: {
        visitor_id: visitorId,
        first_seen: now,
        referrer: referrer || 'Direct'
      }
    };
    if (Object.keys(visitorInc).length) visitorUpdate.$inc = visitorInc;
    await visitors.updateOne({ visitor_id: visitorId }, visitorUpdate, { upsert: true });

    // Update daily counter
    const dailyInc = { updated_count: 1 };
    if (eventType === 'visit') dailyInc.visits = 1;
    if (watchSec > 0) dailyInc.watch_seconds = watchSec;
    if (eventType === 'share') dailyInc.shares = 1;
    if (eventType === 'share_open') dailyInc.share_opens = 1;
    if (eventType === 'search') dailyInc.searches = 1;
    if (eventType === 'play') dailyInc.plays = 1;
    if (eventType === 'paywall_hit') dailyInc.paywall_hits = 1;
    if (eventType === 'pwa_install') dailyInc.pwa_installs = 1;

    await analyticsCounters.updateOne(
      { key: `daily:${today}` },
      {
        $set: { kind: 'daily', date: today, updated_at: now },
        $inc: dailyInc
      },
      { upsert: true }
    );

    // Handle specific events
    if (eventType === 'share' && itemId) {
      await analyticsCounters.updateOne(
        { key: `share_item:${itemId}` },
        {
          $set: {
            kind: 'share_item',
            item_id: itemId,
            title: itemTitle || itemId,
            item_type: itemType || 'film',
            vj: vj || '',
            poster: poster || '',
            updated_at: now
          },
          $inc: { count: 1 }
        },
        { upsert: true }
      );
    } else if (eventType === 'share_open' && itemId) {
      await analyticsCounters.updateOne(
        { key: `share_item:${itemId}` },
        {
          $set: {
            kind: 'share_item',
            item_id: itemId,
            title: itemTitle || itemId,
            item_type: itemType || 'film',
            vj: vj || '',
            poster: poster || '',
            updated_at: now
          },
          $inc: { share_opens: 1 },
          $setOnInsert: { count: 0 }
        },
        { upsert: true }
      );
    } else if (eventType === 'search' && query) {
      const normQ = query.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normQ.length >= 2) {
        await analyticsCounters.updateOne(
          { key: `search_query:${normQ}` },
          {
            $set: {
              kind: 'search_query',
              query: normQ,
              display_query: query,
              results_count: resultsCount ?? 0,
              zero_results: (resultsCount ?? 0) === 0,
              updated_at: now
            },
            $inc: { count: 1 }
          },
          { upsert: true }
        );
      }
    } else if (eventType === 'play' && itemId) {
      await analyticsCounters.updateOne(
        { key: `play_item:${itemId}` },
        {
          $set: {
            kind: 'play_item',
            item_id: itemId,
            title: itemTitle || itemId,
            item_type: itemType || 'film',
            vj: vj || '',
            poster: poster || '',
            updated_at: now
          },
          $inc: { count: 1 }
        },
        { upsert: true }
      );
      if (vj) {
        await analyticsCounters.updateOne(
          { key: `vj_play:${vj}` },
          {
            $set: { kind: 'vj_play', vj, updated_at: now },
            $inc: { count: 1 }
          },
          { upsert: true }
        );
      }
    } else if (eventType === 'watch_tick' && watchSec > 0 && itemId) {
      await analyticsCounters.updateOne(
        { key: `play_item:${itemId}` },
        {
          $set: {
            kind: 'play_item',
            item_id: itemId,
            title: itemTitle || itemId,
            item_type: itemType || 'film',
            vj: vj || '',
            updated_at: now
          },
          $inc: { watch_seconds: watchSec },
          $setOnInsert: { count: 1 }
        },
        { upsert: true }
      );
      if (vj) {
        await analyticsCounters.updateOne(
          { key: `vj_play:${vj}` },
          {
            $set: { kind: 'vj_play', vj, updated_at: now },
            $inc: { watch_seconds: watchSec },
            $setOnInsert: { count: 1 }
          },
          { upsert: true }
        );
      }
    } else if (eventType === 'watchlist' && itemId) {
      const added = body.added !== false;
      await analyticsCounters.updateOne(
        { key: `watchlist_item:${itemId}` },
        {
          $set: {
            kind: 'watchlist_item',
            item_id: itemId,
            title: itemTitle || itemId,
            item_type: itemType || 'film',
            vj: vj || '',
            poster: poster || '',
            updated_at: now
          },
          $inc: { count: added ? 1 : -1 }
        },
        { upsert: true }
      );
    } else if (eventType === 'stream_error' && itemId) {
      await analyticsCounters.updateOne(
        { key: `error_item:${itemId}` },
        {
          $set: {
            kind: 'error_item',
            item_id: itemId,
            title: itemTitle || itemId,
            item_type: itemType || 'film',
            vj: vj || '',
            updated_at: now
          },
          $inc: { count: 1 }
        },
        { upsert: true }
      );
    }

    // Store discrete event log for non-heartbeat events
    if (!['heartbeat', 'watch_tick'].includes(eventType)) {
      await analyticsEvents.insertOne({
        id: crypto.randomUUID(),
        type: eventType,
        visitor_id: visitorId,
        user_id: userId,
        user_email: userEmail,
        user_name: userName,
        device_type: deviceType,
        os,
        browser,
        is_pwa: isPwa,
        pass_mode: passMode,
        has_active_pass: hasActivePass,
        activity,
        item_id: itemId,
        item_title: itemTitle,
        item_type: itemType,
        vj,
        poster,
        query,
        results_count: resultsCount,
        referrer,
        created_at: now
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.warn('Analytics event error:', error.message);
    res.status(200).json({ ok: false });
  }
});

app.post('/api/analytics/sync-browser', throttle({ windowMs: 60 * 1000, limit: 60 }), async (req, res) => {
  try {
    const body = req.body || {};
    const visitorId = String(body.visitorId || '').trim().slice(0, 80);
    if (!visitorId) return res.json({ ok: false });

    const now = new Date();
    const today = todayKeyUtc(now);
    const uaInfo = parseUserAgentInfo(req.get('user-agent') || '', Boolean(body.isTv));
    const user = body.user || null;
    const progressItems = Array.isArray(body.progressItems) ? body.progressItems.slice(0, 100) : [];
    const watchlistItems = Array.isArray(body.watchlistItems) ? body.watchlistItems.slice(0, 100) : [];
    const sharesList = Array.isArray(body.sharesList) ? body.sharesList.slice(0, 60) : [];
    const searchesList = Array.isArray(body.searchesList) ? body.searchesList.slice(0, 60) : [];
    const watchSecondsUsed = Math.max(0, Number(body.watchSecondsUsed) || 0);
    const activity = String(body.activity || 'Browsing Home').slice(0, 140);
    const hasActivePass = Boolean(body.hasActivePass);
    const passMode = String(body.passMode || (hasActivePass ? 'VIP Pass' : '3h Free Trial')).slice(0, 40);

    // Register live session
    const prev = liveSessions.get(visitorId);
    liveSessions.set(visitorId, {
      visitorId,
      userId: user?.id || prev?.userId || null,
      userEmail: user?.email || prev?.userEmail || null,
      userName: user?.displayName || prev?.userName || null,
      deviceType: uaInfo.deviceType,
      os: uaInfo.os,
      browser: uaInfo.browser,
      isPwa: Boolean(body.isPwa),
      passMode,
      hasActivePass,
      freeRemainingSec: body.freeRemainingSec ?? prev?.freeRemainingSec ?? null,
      activity,
      itemId: body.itemId || prev?.itemId || null,
      itemTitle: body.itemTitle || prev?.itemTitle || null,
      itemType: body.itemType || prev?.itemType || null,
      vj: body.vj || prev?.vj || null,
      startedAt: prev?.startedAt || now,
      lastSeen: now
    });

    const existingVisitor = await visitors.findOne({ visitor_id: visitorId });
    const alreadySyncedIds = new Set(existingVisitor?.synced_item_ids || []);
    const newSyncedIds = [...alreadySyncedIds];

    let newlyAddedPlays = 0;
    let newlyAddedWatchSec = 0;

    for (const item of progressItems) {
      if (!item || !item.id) continue;
      const itemId = String(item.id).slice(0, 100);
      const watchSec = Math.max(10, Math.round(Number(item.watchSec) || 60));
      const isNewForVisitor = !alreadySyncedIds.has(`play:${itemId}`);
      if (isNewForVisitor) {
        newSyncedIds.push(`play:${itemId}`);
        newlyAddedPlays++;
        newlyAddedWatchSec += watchSec;
        await analyticsCounters.updateOne(
          { key: `play_item:${itemId}` },
          {
            $set: {
              kind: 'play_item',
              item_id: itemId,
              title: String(item.title || itemId).slice(0, 160),
              item_type: String(item.type || 'film').slice(0, 30),
              vj: String(item.vj || '').slice(0, 60),
              poster: String(item.poster || '').slice(0, 400),
              updated_at: now
            },
            $inc: { count: 1, watch_seconds: watchSec }
          },
          { upsert: true }
        );
        if (item.vj) {
          const vjName = String(item.vj).slice(0, 60);
          await analyticsCounters.updateOne(
            { key: `vj_play:${vjName}` },
            {
              $set: { kind: 'vj_play', vj: vjName, updated_at: now },
              $inc: { count: 1, watch_seconds: watchSec }
            },
            { upsert: true }
          );
        }
      }
    }

    for (const w of watchlistItems) {
      if (!w || !w.id) continue;
      const itemId = String(w.id).slice(0, 100);
      if (!alreadySyncedIds.has(`wl:${itemId}`)) {
        newSyncedIds.push(`wl:${itemId}`);
        await analyticsCounters.updateOne(
          { key: `watchlist_item:${itemId}` },
          {
            $set: {
              kind: 'watchlist_item',
              item_id: itemId,
              title: String(w.title || itemId).slice(0, 160),
              item_type: String(w.type || 'film').slice(0, 30),
              vj: String(w.vj || '').slice(0, 60),
              poster: String(w.poster || '').slice(0, 400),
              updated_at: now
            },
            $inc: { count: 1 }
          },
          { upsert: true }
        );
      }
    }

    for (const sh of sharesList) {
      if (!sh || !sh.item_id) continue;
      const itemId = String(sh.item_id).slice(0, 100);
      if (!alreadySyncedIds.has(`sh:${itemId}`)) {
        newSyncedIds.push(`sh:${itemId}`);
        const c = Math.max(1, Number(sh.count) || 1);
        const o = Math.max(0, Number(sh.share_opens) || 0);
        await analyticsCounters.updateOne(
          { key: `share_item:${itemId}` },
          {
            $set: {
              kind: 'share_item',
              item_id: itemId,
              title: String(sh.title || itemId).slice(0, 160),
              item_type: String(sh.item_type || 'film').slice(0, 30),
              vj: String(sh.vj || '').slice(0, 60),
              updated_at: now
            },
            $inc: { count: c, share_opens: o }
          },
          { upsert: true }
        );
      }
    }

    for (const sq of searchesList) {
      if (!sq || !sq.query) continue;
      const normQ = String(sq.query).toLowerCase().trim().slice(0, 120);
      if (normQ.length >= 2 && !alreadySyncedIds.has(`sq:${normQ}`)) {
        newSyncedIds.push(`sq:${normQ}`);
        const c = Math.max(1, Number(sq.count) || 1);
        await analyticsCounters.updateOne(
          { key: `search_query:${normQ}` },
          {
            $set: {
              kind: 'search_query',
              query: normQ,
              display_query: String(sq.display_query || sq.query).slice(0, 120),
              results_count: Number(sq.results_count) || 0,
              zero_results: Boolean(sq.zero_results),
              updated_at: now
            },
            $inc: { count: c }
          },
          { upsert: true }
        );
      }
    }

    const totalVisWatch = Math.max(existingVisitor?.watch_seconds || 0, watchSecondsUsed, newlyAddedWatchSec);
    await visitors.updateOne(
      { visitor_id: visitorId },
      {
        $set: {
          last_seen: now,
          device_type: uaInfo.deviceType,
          os: uaInfo.os,
          browser: uaInfo.browser,
          is_pwa: Boolean(body.isPwa),
          pass_mode: passMode,
          has_active_pass: hasActivePass,
          current_activity: activity,
          watch_seconds: totalVisWatch,
          synced_item_ids: newSyncedIds.slice(-300),
          ...(user?.id ? { user_id: user.id } : {}),
          ...(user?.email ? { user_email: user.email } : {}),
          ...(user?.displayName ? { user_name: user.displayName } : {})
        },
        $setOnInsert: {
          visitor_id: visitorId,
          first_seen: now,
          visit_count: 1,
          referrer: 'Direct'
        }
      },
      { upsert: true }
    );

    if (newlyAddedPlays > 0 || newlyAddedWatchSec > 0) {
      await analyticsCounters.updateOne(
        { key: `daily:${today}` },
        {
          $set: { kind: 'daily', date: today, updated_at: now },
          $inc: { plays: newlyAddedPlays, watch_seconds: newlyAddedWatchSec, visits: existingVisitor ? 0 : 1 }
        },
        { upsert: true }
      );
    }

    let pendingMessages = [];
    try {
      const conditions = [{ target_id: visitorId }, { target_type: 'all' }];
      if (user?.id) conditions.push({ target_id: user.id });
      const rawMsgs = await adminMessages.find({ status: 'unread', $or: conditions }).sort({ created_at: -1 }).limit(5).toArray();
      pendingMessages = rawMsgs
        .filter((m) => !(m.target_type === 'all' && Array.isArray(m.dismissed_ids) && m.dismissed_ids.includes(visitorId)))
        .map((m) => ({
          id: m.id,
          sender: m.sender || 'Admin',
          message: m.message,
          targetType: m.target_type,
          createdAt: m.created_at
        }));
    } catch {}

    res.json({ ok: true, syncedPlays: newlyAddedPlays, pendingMessages });
  } catch (err) {
    console.warn('sync-browser error:', err.message);
    res.json({ ok: false });
  }
});

app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const liveCutoff = new Date(now.getTime() - 5 * 60 * 1000);

    const [
      totalUniqueVisitors,
      visitorsToday,
      visitors7d,
      visitors30d,
      liveVisitorDocs,
      recentVisitors,
      dailyCounters,
      topShared,
      topSearches,
      zeroResultSearches,
      topPlayed,
      topVjs,
      topWatchlist,
      streamErrors,
      recentEvents,
      allUsers,
      allSubscriptions,
      allPayments,
      allUserRequests,
      allAdminMessages,
      allRecentSearches
    ] = await Promise.all([
      visitors.countDocuments(),
      visitors.countDocuments({ last_seen: { $gte: startOfToday } }),
      visitors.countDocuments({ last_seen: { $gte: sevenDaysAgo } }),
      visitors.countDocuments({ last_seen: { $gte: thirtyDaysAgo } }),
      visitors.find({ last_seen: { $gte: liveCutoff } }).sort({ last_seen: -1 }).limit(200).toArray(),
      visitors.find({}).sort({ last_seen: -1 }).limit(120).toArray(),
      analyticsCounters.find({ kind: 'daily' }).sort({ date: -1 }).limit(30).toArray(),
      analyticsCounters.find({ kind: 'share_item' }).sort({ count: -1, share_opens: -1 }).limit(40).toArray(),
      analyticsCounters.find({ kind: 'search_query' }).sort({ count: -1 }).limit(50).toArray(),
      analyticsCounters.find({ kind: 'search_query', zero_results: true }).sort({ count: -1 }).limit(30).toArray(),
      analyticsCounters.find({ kind: 'play_item' }).sort({ count: -1, watch_seconds: -1 }).limit(50).toArray(),
      analyticsCounters.find({ kind: 'vj_play' }).sort({ count: -1, watch_seconds: -1 }).limit(25).toArray(),
      analyticsCounters.find({ kind: 'watchlist_item', count: { $gt: 0 } }).sort({ count: -1 }).limit(30).toArray(),
      analyticsCounters.find({ kind: 'error_item', count: { $gt: 0 } }).sort({ count: -1, updated_at: -1 }).limit(30).toArray(),
      analyticsEvents.find({}).sort({ created_at: -1 }).limit(120).toArray(),
      users.find({}, { projection: { password_hash: 0, verify_token_hash: 0, reset_token_hash: 0 } }).sort({ created_at: -1 }).toArray(),
      subscriptions.find({}).toArray(),
      payments.find({}).sort({ created_at: -1 }).limit(300).toArray(),
      userRequests.find({}).sort({ created_at: -1 }).limit(200).toArray(),
      adminMessages.find({}).sort({ created_at: -1 }).limit(100).toArray(),
      analyticsEvents.find({ type: 'search' }).sort({ created_at: -1 }).limit(100).toArray()
    ]);

    // Merge in-memory liveSessions with DB liveVisitorDocs
    const liveMap = new Map();
    for (const doc of liveVisitorDocs) {
      liveMap.set(doc.visitor_id, {
        visitorId: doc.visitor_id,
        userId: doc.user_id || null,
        userEmail: doc.user_email || null,
        userName: doc.user_name || null,
        deviceType: doc.device_type || 'Desktop',
        os: doc.os || 'Other',
        browser: doc.browser || 'Browser',
        isPwa: Boolean(doc.is_pwa),
        passMode: doc.pass_mode || '3h Free Trial',
        hasActivePass: Boolean(doc.has_active_pass),
        freeRemainingSec: doc.free_remaining_sec ?? null,
        activity: doc.current_activity || 'Browsing Home',
        itemId: doc.current_item_id || null,
        itemTitle: doc.current_item_title || null,
        itemType: doc.current_item_type || null,
        vj: doc.current_vj || null,
        lastSeen: doc.last_seen
      });
    }
    for (const [vid, s] of liveSessions) {
      if (new Date(s.lastSeen) >= liveCutoff) {
        liveMap.set(vid, s);
      }
    }
    const activeSessions = Array.from(liveMap.values()).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    let watchingMovieCount = 0;
    let watchingTvCount = 0;
    let browsingCount = 0;
    for (const s of activeSessions) {
      if (s.itemType === 'tv' || String(s.activity || '').toLowerCase().includes('live tv')) watchingTvCount++;
      else if (s.itemType === 'film' || s.itemType === 'series' || String(s.activity || '').toLowerCase().startsWith('watching')) watchingMovieCount++;
      else browsingCount++;
    }

    // Subscriptions & Payments maps
    const subByUser = new Map(allSubscriptions.map((s) => [s.user_id, s]));
    const visitorByUser = new Map();
    for (const v of recentVisitors) {
      if (v.user_id && !visitorByUser.has(v.user_id)) visitorByUser.set(v.user_id, v);
    }

    const paymentsByUser = new Map();
    let totalRevenueUgx = 0;
    let totalRevenueUsd = 0;
    let revenueTodayUgx = 0;
    let revenue30dUgx = 0;
    let totalPaymentsSuccess = 0;
    let totalPaymentsPending = 0;
    let totalPaymentsFailed = 0;

    for (const p of allPayments) {
      const uid = p.user_id;
      if (uid) {
        if (!paymentsByUser.has(uid)) {
          paymentsByUser.set(uid, {
            totalPaidUgx: 0,
            totalPaidUsd: 0,
            successCount: 0,
            pendingCount: 0,
            failedCount: 0,
            lastPayment: p,
            lastSuccessPayment: null
          });
        }
        const entry = paymentsByUser.get(uid);
        if (p.status === 'success') {
          entry.successCount++;
          entry.totalPaidUgx += Number(p.amount_ugx) || 0;
          if (p.currency === 'USD') entry.totalPaidUsd += Number(p.amount) || 0;
          if (!entry.lastSuccessPayment) entry.lastSuccessPayment = p;
        } else if (p.status === 'pending') {
          entry.pendingCount++;
        } else {
          entry.failedCount++;
        }
      }
      if (p.status === 'success') {
        totalPaymentsSuccess++;
        const ugx = Number(p.amount_ugx) || 0;
        totalRevenueUgx += ugx;
        if (p.currency === 'USD') totalRevenueUsd += Number(p.amount) || 0;
        const pDate = new Date(p.completed_at || p.created_at);
        if (pDate >= startOfToday) revenueTodayUgx += ugx;
        if (pDate >= thirtyDaysAgo) revenue30dUgx += ugx;
      } else if (p.status === 'pending') {
        totalPaymentsPending++;
      } else {
        totalPaymentsFailed++;
      }
    }

    // Build enriched members list
    let activePaidPasses = 0;
    let expiredPasses = 0;
    let newMembersToday = 0;
    let newMembers7d = 0;
    let verifiedMembers = 0;

    const members = allUsers.map((u) => {
      const sub = subByUser.get(u.id);
      const payInfo = paymentsByUser.get(u.id);
      const vis = visitorByUser.get(u.id);
      const expiresAt = sub?.expires_at ? new Date(sub.expires_at) : null;
      const isActivePass = Boolean(expiresAt && expiresAt > now);
      if (isActivePass) activePaidPasses++;
      else if (expiresAt) expiredPasses++;

      const createdAt = u.created_at ? new Date(u.created_at) : null;
      if (createdAt && createdAt >= startOfToday) newMembersToday++;
      if (createdAt && createdAt >= sevenDaysAgo) newMembers7d++;
      if (u.email_verified_at) verifiedMembers++;

      const remainingHours = isActivePass ? Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60))) : 0;
      const lastSuccess = payInfo?.lastSuccessPayment;

      return {
        id: u.id,
        email: u.email,
        displayName: u.display_name || u.email.split('@')[0],
        avatar: u.avatar || null,
        verified: Boolean(u.email_verified_at),
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at || vis?.last_seen || u.updated_at || u.created_at,
        subscriptionExpiresAt: expiresAt ? expiresAt.toISOString() : null,
        hasActivePass: isActivePass,
        remainingHours,
        grantedByAdmin: Boolean(sub?.granted_by_admin),
        lastPlanId: lastSuccess?.plan_id || sub?.plan_id || payInfo?.lastPayment?.plan_id || null,
        lastPaymentMethod: lastSuccess?.payment_method || payInfo?.lastPayment?.payment_method || (sub?.granted_by_admin ? 'admin_grant' : null),
        lastNetwork: lastSuccess?.network || payInfo?.lastPayment?.network || null,
        lastPhone: lastSuccess?.phone_number || payInfo?.lastPayment?.phone_number || null,
        totalPaidUgx: payInfo?.totalPaidUgx || 0,
        totalPaidUsd: payInfo?.totalPaidUsd || 0,
        successPaymentsCount: payInfo?.successCount || 0,
        pendingPaymentsCount: payInfo?.pendingCount || 0,
        failedPaymentsCount: payInfo?.failedCount || 0,
        lastPaidAt: lastSuccess?.completed_at || lastSuccess?.created_at || (isActivePass ? sub?.updated_at : null),
        deviceType: vis?.device_type || null,
        os: vis?.os || null,
        watchSeconds: vis?.watch_seconds || 0,
        currentActivity: vis?.current_activity || null
      };
    });

    const paidMembers = members.filter((m) => m.hasActivePass || m.successPaymentsCount > 0 || m.subscriptionExpiresAt);

    // Aggregate totals from counters
    let totalVisits = 0;
    let totalWatchSeconds = 0;
    let totalShares = 0;
    let totalShareOpens = 0;
    let totalSearches = 0;
    let totalPlays = 0;
    let paywallHits = 0;
    let pwaInstalls = 0;

    for (const d of dailyCounters) {
      totalVisits += Number(d.visits) || 0;
      totalWatchSeconds += Number(d.watch_seconds) || 0;
      totalShares += Number(d.shares) || 0;
      totalShareOpens += Number(d.share_opens) || 0;
      totalSearches += Number(d.searches) || 0;
      totalPlays += Number(d.plays) || 0;
      paywallHits += Number(d.paywall_hits) || 0;
      pwaInstalls += Number(d.pwa_installs) || 0;
    }

    // Device & OS & Pass funnel breakdown from recentVisitors
    const deviceBreakdown = { Mobile: 0, 'Smart TV': 0, Desktop: 0, Tablet: 0 };
    const osBreakdown = {};
    const passFunnel = { 'VIP Pass': 0, '3h Free Trial': 0, '30m Daily Free': 0, 'Trial Ended': 0 };
    for (const v of recentVisitors) {
      const dt = v.device_type || 'Desktop';
      deviceBreakdown[dt] = (deviceBreakdown[dt] || 0) + 1;
      const o = v.os || 'Other';
      osBreakdown[o] = (osBreakdown[o] || 0) + 1;
      if (v.has_active_pass) passFunnel['VIP Pass']++;
      else if (String(v.pass_mode || '').includes('daily')) passFunnel['30m Daily Free']++;
      else if (String(v.pass_mode || '').includes('exhausted') || (v.free_remaining_sec !== undefined && v.free_remaining_sec !== null && v.free_remaining_sec <= 0)) passFunnel['Trial Ended']++;
      else passFunnel['3h Free Trial']++;
    }

    const recentShares = recentEvents.filter((e) => e.type === 'share' || e.type === 'share_open').slice(0, 40);
    const recentSearches = (allRecentSearches && allRecentSearches.length) ? allRecentSearches : recentEvents.filter((e) => e.type === 'search').slice(0, 40);
    const topPlayedMovies = topPlayed.filter((x) => x.item_type !== 'tv').slice(0, 30);
    const topPlayedTv = topPlayed.filter((x) => x.item_type === 'tv').slice(0, 20);

    res.json({
      generatedAt: now.toISOString(),
      live: {
        onlineCount: activeSessions.length,
        watchingMovieCount,
        watchingTvCount,
        browsingCount,
        sessions: activeSessions
      },
      overview: {
        totalUniqueVisitors,
        visitorsToday,
        visitors7d,
        visitors30d,
        totalVisits: Math.max(totalVisits, totalUniqueVisitors),
        totalWatchHours: Number((totalWatchSeconds / 3600).toFixed(1)),
        totalWatchSeconds,
        totalPlays,
        totalShares,
        totalShareOpens,
        totalSearches,
        zeroResultSearchesCount: zeroResultSearches.length,
        totalMembers: allUsers.length,
        verifiedMembers,
        newMembersToday,
        newMembers7d,
        activePaidPasses,
        expiredPasses,
        totalPaidMembersCount: paidMembers.length,
        totalRevenueUgx,
        totalRevenueUsd: Number(totalRevenueUsd.toFixed(2)),
        revenueTodayUgx,
        revenue30dUgx,
        totalPaymentsSuccess,
        totalPaymentsPending,
        totalPaymentsFailed,
        paywallHits,
        pwaInstalls
      },
      dailySeries: dailyCounters.slice(0, 14).reverse(),
      breakdown: {
        devices: deviceBreakdown,
        os: osBreakdown,
        passFunnel
      },
      shares: {
        topShared,
        recentShares
      },
      searches: {
        topSearches,
        zeroResultSearches,
        recentSearches
      },
      content: {
        topPlayedMovies,
        topPlayedTv,
        topVjs,
        topWatchlist,
        streamErrors
      },
      members,
      paidMembers,
      payments: allPayments.slice(0, 150),
      userRequests: allUserRequests,
      adminMessages: allAdminMessages,
      recentVisitors: recentVisitors.slice(0, 100),
      recentActivity: recentEvents.slice(0, 80)
    });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/grant-pass', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const email = normalizeEmail(req.body?.email || '');
    const days = Number(req.body?.days) || 0;
    const revoke = Boolean(req.body?.revoke);

    const user = userId ? await users.findOne({ id: userId }) : await users.findOne({ email });
    if (!user) return fail(res, 404, 'Member account not found.');

    const now = new Date();
    if (revoke || days <= 0) {
      await subscriptions.updateOne(
        { user_id: user.id },
        { $set: { expires_at: new Date(0), updated_at: now, granted_by_admin: true } },
        { upsert: true }
      );
      return res.json({ message: `Pass revoked for ${user.email}.`, expiresAt: null });
    }

    const current = await subscriptions.findOne({ user_id: user.id });
    const startAt = current?.expires_at && new Date(current.expires_at) > now ? new Date(current.expires_at) : now;
    const expiry = new Date(startAt.getTime() + days * 24 * 60 * 60 * 1000);

    await subscriptions.updateOne(
      { user_id: user.id },
      {
        $set: {
          expires_at: expiry,
          updated_at: now,
          granted_by_admin: true,
          plan_id: `admin-${days}d`
        },
        $setOnInsert: { user_id: user.id }
      },
      { upsert: true }
    );

    res.json({
      message: `VIP Pass granted to ${user.display_name || user.email} for ${days} day(s) until ${expiry.toLocaleString()}.`,
      expiresAt: expiry.toISOString()
    });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/activate-payment', requireAdmin, async (req, res) => {
  try {
    const reference = String(req.body?.reference || '').trim();
    if (!reference) return fail(res, 400, 'Missing payment reference.');
    const payment = await payments.findOne({ reference });
    if (!payment) return fail(res, 404, 'Payment reference not found.');
    if (payment.status === 'success') return res.json({ message: 'Payment is already active.' });

    await activatePaymentSuccess(payment, { provider: 'admin_verified', provider_transaction_id: `ADMIN_${Date.now()}` });
    res.json({ message: `Payment ${reference} activated and member pass unlocked!` });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/reset-user-password', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!userId) return fail(res, 400, 'Missing userId.');
    if (newPassword.length < 10 || newPassword.length > 200) return fail(res, 400, 'Password must be at least 10 characters.');

    const user = await users.findOne({ id: userId });
    if (!user) return fail(res, 404, 'User not found.');
    const passwordHash = hashPassword(newPassword).encoded;
    await users.updateOne({ id: user.id }, { $set: { password_hash: passwordHash, updated_at: new Date() } });
    res.json({ message: `Password updated for ${user.email}.` });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/requests', throttle({ windowMs: 60 * 1000, limit: 25 }), async (req, res) => {
  try {
    const body = req.body || {};
    const kind = body.kind === 'message' ? 'message' : 'movie';
    const text = String(body.text || '').trim().slice(0, 600);
    if (text.length < 2) return fail(res, 400, 'Please enter your request or message.');

    const vj = String(body.vj || '').trim().slice(0, 80);
    const contact = String(body.contact || '').trim().slice(0, 140);
    const visitorId = String(body.visitorId || req.get('x-visitor-id') || '').trim().slice(0, 80);
    const userId = body.userId ? String(body.userId).slice(0, 80) : null;
    const userName = String(body.userName || '').trim().slice(0, 80) || null;
    const userEmail = String(body.userEmail || '').trim().toLowerCase().slice(0, 200) || null;
    const uaInfo = parseUserAgentInfo(req.get('user-agent') || '', false);
    const now = new Date();
    const id = crypto.randomUUID();

    const doc = {
      id,
      kind,
      text,
      vj: vj || null,
      contact: contact || null,
      visitor_id: visitorId || null,
      user_id: userId,
      user_name: userName,
      user_email: userEmail,
      device_type: uaInfo.deviceType,
      os: uaInfo.os,
      status: 'open',
      created_at: now,
      updated_at: now
    };
    await userRequests.insertOne(doc);

    if (kind === 'movie') {
      const normQ = text.toLowerCase().replace(/\s+/g, ' ').trim();
      await analyticsCounters.updateOne(
        { key: `search_query:${normQ}` },
        {
          $set: {
            kind: 'search_query',
            query: normQ,
            display_query: vj ? `${text} (${vj})` : text,
            results_count: 0,
            zero_results: true,
            updated_at: now
          },
          $inc: { count: 1 }
        },
        { upsert: true }
      );
    }

    await analyticsEvents.insertOne({
      id: crypto.randomUUID(),
      type: kind === 'movie' ? 'movie_request' : 'user_message',
      visitor_id: visitorId || 'guest',
      user_id: userId,
      user_email: userEmail,
      user_name: userName,
      device_type: uaInfo.deviceType,
      os: uaInfo.os,
      activity: kind === 'movie' ? `Movie Request: "${text}"${vj ? ` (${vj})` : ''}` : `Message: "${text.slice(0, 80)}"`,
      query: text,
      vj: vj || null,
      created_at: now
    });

    res.status(201).json({ ok: true, request: doc, message: kind === 'movie' ? 'Movie request sent to Admin!' : 'Message sent to Admin!' });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/request-status', requireAdmin, async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    const status = String(req.body?.status || 'done').trim();
    if (!id) return fail(res, 400, 'Missing request id.');
    await userRequests.updateOne({ id }, { $set: { status, updated_at: new Date() } });
    res.json({ ok: true, message: `Request marked as ${status}.` });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/delete-request', requireAdmin, async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    if (!id) return fail(res, 400, 'Missing request id.');
    await userRequests.deleteOne({ id });
    res.json({ ok: true, message: 'Request removed.' });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/send-message', requireAdmin, async (req, res) => {
  try {
    const targetType = ['visitor', 'user', 'all'].includes(req.body?.targetType) ? req.body.targetType : 'visitor';
    const targetId = String(req.body?.targetId || '').trim();
    const targetName = String(req.body?.targetName || '').trim() || (targetType === 'all' ? 'All Active Viewers' : 'Viewer');
    const message = String(req.body?.message || '').trim().slice(0, 1000);
    const btnYes = String(req.body?.btnYes || 'Yes').trim().slice(0, 30) || 'Yes';
    const btnNo = req.body?.btnNo !== undefined ? String(req.body.btnNo || '').trim().slice(0, 30) : 'No';

    if (!message) return fail(res, 400, 'Please enter a message to send.');
    if (targetType !== 'all' && !targetId) return fail(res, 400, 'Missing target recipient ID.');

    const now = new Date();
    const id = crypto.randomUUID();
    const doc = {
      id,
      sender: 'Admin',
      target_type: targetType,
      target_id: targetId,
      target_name: targetName,
      message,
      btn_yes: btnYes,
      btn_no: btnNo,
      status: 'unread',
      dismissed_ids: [],
      dismissed_at: null,
      reply_text: null,
      replied_at: null,
      replied_by: null,
      created_at: now,
      updated_at: now
    };

    await adminMessages.insertOne(doc);

    await analyticsEvents.insertOne({
      id: crypto.randomUUID(),
      type: 'admin_message_sent',
      visitor_id: targetType === 'visitor' ? targetId : 'broadcast',
      user_id: targetType === 'user' ? targetId : null,
      activity: `Admin message sent to ${targetName}: "${message.slice(0, 50)}"`,
      created_at: now
    });

    res.json({ ok: true, message: `Message successfully sent to ${targetName}!`, msgId: id });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/delete-message', requireAdmin, async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    if (!id) return fail(res, 400, 'Missing message id.');
    await adminMessages.deleteOne({ id });
    res.json({ ok: true, message: 'Message removed.' });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.get('/api/messages/pending', async (req, res) => {
  try {
    const visitorId = String(req.query.visitorId || req.get('x-visitor-id') || '').trim();
    const userId = String(req.query.userId || '').trim();

    if (!visitorId && !userId) return res.json({ ok: true, messages: [] });

    const conditions = [];
    if (visitorId) conditions.push({ target_id: visitorId });
    if (userId) conditions.push({ target_id: userId });
    conditions.push({ target_type: 'all' });

    const list = await adminMessages.find({ status: 'unread', $or: conditions }).sort({ created_at: -1 }).limit(10).toArray();

    const active = list.filter((m) => {
      if (m.target_type === 'all' && Array.isArray(m.dismissed_ids) && visitorId && m.dismissed_ids.includes(visitorId)) {
        return false;
      }
      return true;
    });

    res.json({
      ok: true,
      messages: active.map((m) => ({
        id: m.id,
        sender: m.sender || 'Admin',
        message: m.message,
        targetType: m.target_type,
        btnYes: m.btn_yes || 'Yes',
        btnNo: m.btn_no !== undefined ? m.btn_no : 'No',
        createdAt: m.created_at
      }))
    });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/messages/dismiss', async (req, res) => {
  try {
    const messageId = String(req.body?.messageId || '').trim();
    const visitorId = String(req.body?.visitorId || req.get('x-visitor-id') || '').trim();
    if (!messageId) return fail(res, 400, 'Missing messageId.');

    const msg = await adminMessages.findOne({ id: messageId });
    if (!msg) return res.json({ ok: true });

    const now = new Date();
    if (msg.target_type === 'all') {
      if (visitorId) {
        await adminMessages.updateOne({ id: messageId }, { $addToSet: { dismissed_ids: visitorId }, $set: { updated_at: now } });
      }
    } else {
      await adminMessages.updateOne({ id: messageId }, { $set: { status: 'read', dismissed_at: now, updated_at: now } });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/messages/reply', async (req, res) => {
  try {
    const messageId = String(req.body?.messageId || '').trim();
    const replyText = String(req.body?.replyText || '').trim().slice(0, 1000);
    const visitorId = String(req.body?.visitorId || req.get('x-visitor-id') || '').trim();
    const userId = String(req.body?.userId || '').trim() || null;
    const userName = String(req.body?.userName || '').trim() || 'Viewer';

    if (!messageId) return fail(res, 400, 'Missing messageId.');
    if (!replyText) return fail(res, 400, 'Please enter a reply.');

    const now = new Date();
    const msg = await adminMessages.findOne({ id: messageId });

    if (msg) {
      await adminMessages.updateOne(
        { id: messageId },
        {
          $set: {
            status: 'replied',
            reply_text: replyText,
            replied_at: now,
            replied_by: {
              visitor_id: visitorId,
              user_id: userId,
              user_name: userName
            },
            updated_at: now
          }
        }
      );
    }

    const reqDoc = {
      id: crypto.randomUUID(),
      kind: 'message',
      text: `[Reply to "${(msg?.message || '').slice(0, 40)}..."]: ${replyText}`,
      visitor_id: visitorId || null,
      user_id: userId,
      user_name: userName,
      contact: userName,
      status: 'open',
      reply_to_message_id: messageId,
      created_at: now,
      updated_at: now
    };
    await userRequests.insertOne(reqDoc);

    await analyticsEvents.insertOne({
      id: crypto.randomUUID(),
      type: 'user_message',
      visitor_id: visitorId || 'guest',
      user_id: userId,
      user_name: userName,
      activity: `Replied to Admin: "${replyText.slice(0, 50)}"`,
      created_at: now
    });

    res.json({ ok: true, message: 'Reply sent to Admin!' });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    if (!userId) return fail(res, 400, 'Missing userId.');
    await Promise.all([
      users.deleteOne({ id: userId }),
      subscriptions.deleteOne({ user_id: userId }),
      visitors.deleteMany({ $or: [{ user_id: userId }, { visitor_id: `member_${userId}` }] })
    ]);
    for (const [k, v] of liveSessions) {
      if (v.userId === userId || k === `member_${userId}`) liveSessions.delete(k);
    }
    res.json({ message: 'Member account removed.' });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
});

app.post('/api/admin/clear-errors', requireAdmin, async (_req, res) => {
  try {
    await analyticsCounters.deleteMany({ kind: 'error_item' });
    res.json({ message: 'Stream error alerts cleared.' });
  } catch (error) {
    res.status(500).json(publicError(error));
  }
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
