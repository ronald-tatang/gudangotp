const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ── HeroSMS ───────────────────────────────────────────────
const HERO_API_KEY = process.env.HEROSMS_API_KEY || 'Accf6bd15c1b59e0f3b63ff50e0f8fcf';
const HERO_URL     = 'https://hero-sms.com/stubs/handler_api.php';

// ── Midtrans ──────────────────────────────────────────────
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const SNAP_URL            = 'https://app.midtrans.com/snap/v1/transactions';
const MIDTRANS_STATUS_URL = 'https://api.midtrans.com/v2';

// ── Markup harga ke reseller ──────────────────────────────
const COIN_TO_IDR = 27000;
const MARGIN_FLAT = 5000;
const MARGIN_PCT  = 0;

function coinToIDR(coin) {
  const base = Math.ceil(parseFloat(coin || 0) * COIN_TO_IDR);
  return base + MARGIN_FLAT + Math.ceil(base * MARGIN_PCT / 100);
}

async function heroCall(params) {
  const res = await axios.get(HERO_URL, {
    params: { api_key: HERO_API_KEY, ...params },
    timeout: 15000,
  });
  return res.data;
}

// ── Redis helpers ─────────────────────────────────────────
async function getResellerBalance(apiKey) {
  const val = await kv.get(`reseller:${apiKey}:balance`);
  return parseInt(val || 0);
}
async function setResellerBalance(apiKey, amount) {
  await kv.set(`reseller:${apiKey}:balance`, amount);
}
async function addResellerTx(apiKey, tx) {
  await kv.lpush(`reseller:${apiKey}:txs`, JSON.stringify({ ...tx, createdAt: Date.now() }));
  await kv.ltrim(`reseller:${apiKey}:txs`, 0, 199);
}
async function getReseller(apiKey) {
  if (!apiKey) return null;
  const raw = await kv.get(`reseller:key:${apiKey}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
async function getResellerByEmail(email) {
  const key = await kv.get(`reseller:email:${email.toLowerCase()}`);
  if (!key) return null;
  return getReseller(key);
}

// ── Middleware ────────────────────────────────────────────
async function requireApiKey(req, res) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) {
    res.status(401).json({ error: 'x-api-key header wajib diisi' });
    return null;
  }
  const reseller = await getReseller(apiKey);
  if (!reseller) {
    res.status(403).json({ error: 'API key tidak valid' });
    return null;
  }
  if (reseller.suspended) {
    res.status(403).json({ error: 'Akun reseller disuspend' });
    return null;
  }
  return { ...reseller, apiKey };
}

// ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action   = req.query.action;
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const isAdmin  = adminKey && adminKey === process.env.RESELLER_ADMIN_KEY;

  try {

    // ══════════════════════════════════════════════════════
    // PUBLIC: Daftar reseller baru
    // ══════════════════════════════════════════════════════
    if (action === 'register' && req.method === 'POST') {
      const { name, email, password } = req.body || {};

      if (!name || !email || !password)
        return res.status(400).json({ error: 'name, email, dan password wajib diisi' });
      if (password.length < 6)
        return res.status(400).json({ error: 'Password minimal 6 karakter' });

      const emailLower = email.toLowerCase();
      const existing   = await kv.get(`reseller:email:${emailLower}`);
      if (existing)
        return res.status(409).json({ error: 'Email sudah terdaftar' });

      const newKey      = 'rsl_' + crypto.randomBytes(16).toString('hex');
      const passHash    = crypto.createHash('sha256').update(password).digest('hex');
      const reseller    = {
        name,
        email:     emailLower,
        passHash,
        apiKey:    newKey,
        balance:   0,
        suspended: false,
        createdAt: Date.now(),
      };

      await kv.set(`reseller:key:${newKey}`, JSON.stringify(reseller));
      await kv.set(`reseller:email:${emailLower}`, newKey);
      await kv.lpush('reseller:list', newKey);

      return res.status(201).json({
        success: true,
        message: 'Pendaftaran berhasil! Silakan top up saldo untuk mulai beli nomor.',
        apiKey:  newKey,
        name,
        email:   emailLower,
        balance: 0,
      });
    }

    // ══════════════════════════════════════════════════════
    // PUBLIC: Login (ambil API key dari email+password)
    // ══════════════════════════════════════════════════════
    if (action === 'login' && req.method === 'POST') {
      const { email, password } = req.body || {};
      if (!email || !password)
        return res.status(400).json({ error: 'email dan password wajib' });

      const reseller = await getResellerByEmail(email);
      if (!reseller)
        return res.status(404).json({ error: 'Email tidak ditemukan' });

      const passHash = crypto.createHash('sha256').update(password).digest('hex');
      if (passHash !== reseller.passHash)
        return res.status(401).json({ error: 'Password salah' });

      if (reseller.suspended)
        return res.status(403).json({ error: 'Akun disuspend, hubungi admin' });

      const balance = await getResellerBalance(reseller.apiKey);
      return res.json({
        success: true,
        apiKey:  reseller.apiKey,
        name:    reseller.name,
        email:   reseller.email,
        balance,
      });
    }

    // ══════════════════════════════════════════════════════
    // PUBLIC: Top up saldo via Midtrans Snap
    // ══════════════════════════════════════════════════════
    if (action === 'topup' && req.method === 'POST') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;

      const { amount } = req.body || {};
      if (!amount || parseInt(amount) < 10000)
        return res.status(400).json({ error: 'Minimal top up Rp10.000' });

      const orderId = `RSL-${reseller.apiKey.substring(4, 16)}-${Date.now()}`;
      const auth    = Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');

      const { data } = await axios.post(SNAP_URL, {
        transaction_details: {
          order_id:     orderId,
          gross_amount: parseInt(amount),
        },
        item_details: [{
          id:       'reseller-topup',
          price:    parseInt(amount),
          quantity: 1,
          name:     'Top Up Saldo Reseller',
        }],
        customer_details: {
          first_name: reseller.name,
          email:      reseller.email,
        },
        enabled_payments: [
          'gopay', 'shopeepay', 'dana', 'ovo', 'other_qris',
          'bca_va', 'bni_va', 'bri_va', 'other_va',
          'indomaret', 'alfamart',
        ],
        expiry: { duration: 30, unit: 'minutes' },
        custom_field1: reseller.apiKey, // simpan apiKey untuk webhook
      }, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type':  'application/json',
        },
      });

      // Simpan pending topup di Redis
      await kv.set(
        `reseller:topup:${orderId}`,
        JSON.stringify({ apiKey: reseller.apiKey, amount: parseInt(amount), status: 'pending' }),
        { ex: 3600 }
      );

      return res.json({
        orderId,
        paymentUrl: data.redirect_url,
        amount:     parseInt(amount),
      });
    }

    // ══════════════════════════════════════════════════════
    // PUBLIC: Cek status top up (polling dari client)
    // ══════════════════════════════════════════════════════
    if (action === 'topup_status') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;

      const { order_id } = req.query;
      if (!order_id) return res.status(400).json({ error: 'order_id wajib' });

      const auth   = Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');
      const { data } = await axios.get(`${MIDTRANS_STATUS_URL}/${order_id}/status`, {
        headers: { 'Authorization': `Basic ${auth}` },
      });

      const paid = data.transaction_status === 'settlement' || data.transaction_status === 'capture';

      if (paid) {
        const doneKey = `reseller:topup:${order_id}:done`;
        const done    = await kv.get(doneKey);
        if (!done) {
          const amount  = parseInt(data.gross_amount);
          const cur     = await getResellerBalance(reseller.apiKey);
          await setResellerBalance(reseller.apiKey, cur + amount);
          await addResellerTx(reseller.apiKey, {
            type:        'topup',
            orderId:     order_id,
            amount,
            description: 'Top Up Saldo via Midtrans',
            status:      'success',
          });
          await kv.set(doneKey, '1', { ex: 86400 * 30 });
        }
      }

      const balance = await getResellerBalance(reseller.apiKey);
      return res.json({
        orderId: order_id,
        paid,
        status:  data.transaction_status,
        amount:  data.gross_amount,
        balance,
      });
    }

    // ══════════════════════════════════════════════════════
    // ADMIN ENDPOINTS
    // ══════════════════════════════════════════════════════

    if (action === 'admin_create' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin key salah' });
      const { name, email } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name wajib' });
      const newKey   = 'rsl_' + crypto.randomBytes(16).toString('hex');
      const reseller = { name, email: email || '', apiKey: newKey, balance: 0, suspended: false, createdAt: Date.now() };
      await kv.set(`reseller:key:${newKey}`, JSON.stringify(reseller));
      if (email) await kv.set(`reseller:email:${email.toLowerCase()}`, newKey);
      await kv.lpush('reseller:list', newKey);
      return res.json({ success: true, apiKey: newKey, reseller });
    }

    if (action === 'admin_topup' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin key salah' });
      const { apiKey: targetKey, amount, note } = req.body || {};
      if (!targetKey || !amount) return res.status(400).json({ error: 'apiKey dan amount wajib' });
      const reseller = await getReseller(targetKey);
      if (!reseller) return res.status(404).json({ error: 'Reseller tidak ditemukan' });
      const cur    = await getResellerBalance(targetKey);
      const newBal = cur + parseInt(amount);
      await setResellerBalance(targetKey, newBal);
      await addResellerTx(targetKey, { type: 'topup', amount, description: note || 'Top Up oleh Admin', status: 'success' });
      return res.json({ success: true, apiKey: targetKey, balance: newBal });
    }

    if (action === 'admin_suspend' && req.method === 'POST') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin key salah' });
      const { apiKey: targetKey, suspend } = req.body || {};
      if (!targetKey) return res.status(400).json({ error: 'apiKey wajib' });
      const reseller = await getReseller(targetKey);
      if (!reseller) return res.status(404).json({ error: 'Reseller tidak ditemukan' });
      reseller.suspended = suspend !== false;
      await kv.set(`reseller:key:${targetKey}`, JSON.stringify(reseller));
      return res.json({ success: true, apiKey: targetKey, suspended: reseller.suspended });
    }

    if (action === 'admin_list') {
      if (!isAdmin) return res.status(403).json({ error: 'Admin key salah' });
      const keys     = await kv.lrange('reseller:list', 0, 99);
      const resellers = await Promise.all(keys.map(async (k) => {
        const r = await getReseller(k);
        if (!r) return null;
        const balance = await getResellerBalance(k);
        return { ...r, passHash: undefined, balance };
      }));
      return res.json({ resellers: resellers.filter(Boolean) });
    }

    // ══════════════════════════════════════════════════════
    // RESELLER ENDPOINTS
    // ══════════════════════════════════════════════════════

    if (action === 'info') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      const balance = await getResellerBalance(reseller.apiKey);
      return res.json({ name: reseller.name, email: reseller.email, balance, apiKey: reseller.apiKey });
    }

    if (action === 'services') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      try {
        const data = await heroCall({ action: 'getServicesList' });
        if (data && typeof data === 'object' && !Array.isArray(data) && !data.status) {
          return res.json(Object.entries(data).map(([code, name]) => ({
            code, name: typeof name === 'string' ? name : (name.name || code),
          })));
        }
      } catch (e) {}
      return res.json([]);
    }

    if (action === 'countries') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      try {
        const data = await heroCall({ action: 'getCountries' });
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return res.json(Object.entries(data).map(([id, val]) => ({
            id, name: typeof val === 'object' ? (val.eng || val.name || id) : (val || id),
          })));
        }
      } catch (e) {}
      return res.json([]);
    }

    if (action === 'price') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      const { service, country } = req.query;
      if (!service || !country) return res.status(400).json({ error: 'service dan country wajib' });
      const data     = await heroCall({ action: 'getPrices', service, country });
      const m        = JSON.stringify(data).match(/"cost"\s*:\s*"?([\d.]+)"?/i);
      const costCoin = m ? parseFloat(m[1]) : 0;
      return res.json({ service, country, price: costCoin > 0 ? coinToIDR(costCoin) : null, available: costCoin > 0 });
    }

    if (action === 'prices') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      const params = { action: 'getPrices' };
      if (req.query.country) params.country = req.query.country;
      if (req.query.service) params.service = req.query.service;
      const data = await heroCall(params);
      function transform(obj) {
        if (typeof obj !== 'object' || obj === null) return obj;
        if ('cost' in obj) return { ...obj, cost: coinToIDR(obj.cost) };
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = transform(v);
        return out;
      }
      return res.json(transform(data));
    }

    if (action === 'buy' && req.method === 'POST') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      const { service, country } = req.body || {};
      if (!service || !country) return res.status(400).json({ error: 'service dan country wajib' });

      const priceData = await heroCall({ action: 'getPrices', service, country });
      const m         = JSON.stringify(priceData).match(/"cost"\s*:\s*"?([\d.]+)"?/i);
      const costCoin  = m ? parseFloat(m[1]) : 0;
      if (costCoin === 0) return res.status(400).json({ error: 'Layanan/negara tidak tersedia' });

      const price   = coinToIDR(costCoin);
      const balance = await getResellerBalance(reseller.apiKey);
      if (balance < price)
        return res.status(402).json({ error: 'Saldo tidak cukup', balance, required: price });

      await setResellerBalance(reseller.apiKey, balance - price);

      const result = await heroCall({ action: 'getNumber', service, country });
      if (typeof result === 'string' && result.startsWith('ACCESS_NUMBER')) {
        const parts = result.split(':');
        await addResellerTx(reseller.apiKey, {
          type: 'buy', amount: -price,
          description: `Beli Nomor ${service} (${parts[2]})`,
          activationId: parts[1], phone: parts[2], service, country, status: 'success',
        });
        return res.json({ success: true, activationId: parts[1], phone: parts[2], price, balance: balance - price });
      }

      // Refund
      await setResellerBalance(reseller.apiKey, balance);
      await addResellerTx(reseller.apiKey, { type: 'refund', amount: price, description: `Refund Gagal Beli ${service}`, status: 'refunded' });
      return res.status(400).json({ error: result || 'Gagal beli nomor', refunded: true, balance });
    }

    if (action === 'sms') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id aktivasi wajib' });
      const data = await heroCall({ action: 'getStatus', id });
      let status = 'waiting', otp = null;
      if (typeof data === 'string') {
        if (data.startsWith('STATUS_OK')) { status = 'received'; otp = data.split(':')[1]; }
        else if (data === 'STATUS_CANCEL')    status = 'cancelled';
        else if (data === 'STATUS_WAIT_RETRY') status = 'retry';
      }
      return res.json({ id, status, otp });
    }

    if (action === 'cancel' && req.method === 'POST') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id aktivasi wajib' });
      const data = await heroCall({ action: 'setStatus', id, status: 8 });
      return res.json({ success: data === 'ACCESS_CANCEL', result: data });
    }

    if (action === 'history') {
      const reseller = await requireApiKey(req, res);
      if (!reseller) return;
      const txs = await kv.lrange(`reseller:${reseller.apiKey}:txs`, 0, 49);
      return res.json({ transactions: txs.map(t => typeof t === 'string' ? JSON.parse(t) : t) });
    }

    return res.status(404).json({ error: 'Action tidak dikenal: ' + action });

  } catch (e) {
    const msg = e.response?.data || e.message;
    console.error(`[reseller] action=${action} error:`, msg);
    return res.status(500).json({ error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
};
