const axios = require('axios');

const API_KEY = process.env.HEROSMS_API_KEY || 'Accf6bd15c1b59e0f3b63ff50e0f8fcf';
const API_URL = 'https://hero-sms.com/stubs/handler_api.php';

// 1 coin = Rp 27.000, margin flat Rp 3.000
const COIN_TO_IDR = 27000;
const MARGIN_FLAT = 3000;

function coinToIDR(coin) {
  return Math.ceil(parseFloat(coin || 0) * COIN_TO_IDR) + MARGIN_FLAT;
}

async function heroCall(params) {
  const res = await axios.get(API_URL, {
    params: { api_key: API_KEY, ...params },
    timeout: 15000
  });
  return res.data;
}

const DEFAULT_COUNTRIES = [
  { id: '6',   name: 'Indonesia 🇮🇩' },
  { id: '0',   name: 'Russia 🇷🇺' },
  { id: '187', name: 'USA 🇺🇸' },
  { id: '22',  name: 'Philippines 🇵🇭' },
  { id: '14',  name: 'India 🇮🇳' },
  { id: '55',  name: 'Malaysia 🇲🇾' },
  { id: '44',  name: 'Thailand 🇹🇭' },
  { id: '132', name: 'Vietnam 🇻🇳' },
  { id: '7',   name: 'Kazakhstan 🇰🇿' },
  { id: '73',  name: 'Bangladesh 🇧🇩' },
  { id: '52',  name: 'Laos 🇱🇦' },
  { id: '36',  name: 'Colombia 🇨🇴' },
  { id: '4',   name: 'Armenia 🇦🇲' },
  { id: '8',   name: 'Ukraine 🇺🇦' },
  { id: '31',  name: 'China 🇨🇳' },
  { id: '48',  name: 'Kyrgyzstan 🇰🇬' },
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {

    // ── BALANCE ──────────────────────────────────────────────
    if (action === 'balance') {
      const data = await heroCall({ action: 'getBalance' });
      const balance = typeof data === 'string' ? (data.split(':')[1] || '0') : '0';
      return res.json({ balance });
    }

    // ── SERVICES ─────────────────────────────────────────────
    if (action === 'services') {
      try {
        const data = await heroCall({ action: 'getServicesList' });
        if (data && typeof data === 'object' && !Array.isArray(data) && !data.status) {
          const list = Object.entries(data).map(([code, name]) => ({
            code,
            name: typeof name === 'string' ? name : (name.name || code)
          }));
          if (list.length > 5) return res.json(list);
        }
        if (data && data.status === 'success' && Array.isArray(data.services) && data.services.length > 5) {
          return res.json(data.services);
        }
      } catch(e) {}
      return res.json([]);
    }

    // ── COUNTRIES ─────────────────────────────────────────────
    if (action === 'countries') {
      try {
        const data = await heroCall({ action: 'getCountries' });
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const list = Object.entries(data).map(([id, val]) => ({
            id,
            name: typeof val === 'object' ? (val.eng || val.name || id) : (val || id)
          }));
          if (list.length > 3) return res.json(list);
        }
      } catch(e) {}
      return res.json(DEFAULT_COUNTRIES);
    }

    // ── ALL PRICES — coin → IDR + margin + sort ──────────────
    if (action === 'getPrices') {
      const params = { action: 'getPrices' };
      if (req.query.country) params.country = req.query.country;
      if (req.query.service) params.service = req.query.service;
      const data = await heroCall(params);

      function transformPrices(obj) {
        if (typeof obj !== 'object' || obj === null) return obj;
        if ('cost' in obj) {
          return { ...obj, cost: coinToIDR(obj.cost) };
        }
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = transformPrices(v);
        return out;
      }
      const transformed = transformPrices(data);

      // Sort: price_asc = terendah ke tertinggi, price_desc = tertinggi ke terendah
      const sort = req.query.sort;
      if (sort && typeof transformed === 'object' && !Array.isArray(transformed)) {
        const rows = [];
        for (const [svc, countries] of Object.entries(transformed)) {
          if (typeof countries === 'object') {
            for (const [cnt, val] of Object.entries(countries)) {
              if (typeof val === 'object' && 'cost' in val) {
                rows.push({ service: svc, country: cnt, ...val });
              }
            }
          }
        }
        if (sort === 'price_asc') rows.sort((a, b) => (a.cost || 0) - (b.cost || 0));
        if (sort === 'price_desc') rows.sort((a, b) => (b.cost || 0) - (a.cost || 0));
        return res.json(rows);
      }

      return res.json(transformed);
    }

    // ── PRICES per service+country — return IDR + margin ─────
    if (action === 'prices') {
      const { service, country } = req.query;
      if (!service || !country) return res.json({});
      const data = await heroCall({ action: 'getPrices', service, country });

      const str = JSON.stringify(data);
      const m = str.match(/"cost"\s*:\s*"?([\d.]+)"?/i);
      const costCoin = m ? parseFloat(m[1]) : 0;
      const costIDR = costCoin > 0 ? coinToIDR(costCoin) : null;

      return res.json({ raw: data, idr: costIDR });
    }

    // ── SMS STATUS — langsung dari API ────────────────────────
    if (action === 'sms') {
      const data = await heroCall({ action: 'getStatus', id: req.query.id });
      let status = 'waiting', otp = null;
      if (typeof data === 'string') {
        if (data.startsWith('STATUS_OK')) { status = 'received'; otp = data.split(':')[1]; }
        else if (data === 'STATUS_CANCEL') status = 'cancelled';
        else if (data === 'STATUS_WAIT_RETRY') status = 'retry';
      }
      return res.json({ status, otp, raw: data });
    }

    // ── ACTIVE ACTIVATIONS ───────────────────────────────────
    if (action === 'active') {
      const data = await heroCall({ action: 'getActiveActivations' });
      return res.json(data);
    }

    // ── BUY NUMBER ───────────────────────────────────────────
    if (action === 'buy' && req.method === 'POST') {
      const body = req.body || {};
      if (!body.service || !body.country)
        return res.status(400).json({ error: 'service dan country wajib diisi' });

      const userId = req.headers['x-user-id'] || body.user_id;
      const price = parseInt(body.price || 0);

      if (userId && price > 0) {
        const { Redis } = require('@upstash/redis');
        const kv = new Redis({
          url: process.env.KV_REST_API_URL,
          token: process.env.KV_REST_API_TOKEN,
        });

        const balance = parseInt(await kv.get(`wallet:${userId}:balance`) || 0);
        if (balance < price) {
          return res.status(402).json({ error: 'Saldo tidak cukup', balance, required: price });
        }

        // Potong saldo
        await kv.set(`wallet:${userId}:balance`, balance - price);
        await kv.lpush(`wallet:${userId}:txs`, JSON.stringify({
          type: 'deduct', amount: -price,
          description: `Beli Nomor OTP (${body.service})`,
          status: 'pending', createdAt: Date.now()
        }));
        await kv.ltrim(`wallet:${userId}:txs`, 0, 99);

        // Beli nomor dari HeroSMS
        const data = await heroCall({ action: 'getNumber', service: body.service, country: body.country });
        if (typeof data === 'string' && data.startsWith('ACCESS_NUMBER')) {
          const parts = data.split(':');
          return res.json({ activationId: parts[1], phone: parts[2], balance: balance - price });
        }

        // Gagal → refund otomatis
        const newBalance = parseInt(await kv.get(`wallet:${userId}:balance`) || 0);
        await kv.set(`wallet:${userId}:balance`, newBalance + price);
        await kv.lpush(`wallet:${userId}:txs`, JSON.stringify({
          type: 'refund', amount: price,
          description: `Refund Gagal Beli Nomor (${body.service})`,
          status: 'success', createdAt: Date.now()
        }));
        await kv.ltrim(`wallet:${userId}:txs`, 0, 99);
        return res.status(400).json({ error: data, refunded: true, balance: newBalance + price });
      }

      // Fallback tanpa wallet
      const data = await heroCall({ action: 'getNumber', service: body.service, country: body.country });
      if (typeof data === 'string' && data.startsWith('ACCESS_NUMBER')) {
        const parts = data.split(':');
        return res.json({ activationId: parts[1], phone: parts[2] });
      }
      return res.status(400).json({ error: data });
    }

    // ── SET STATUS ───────────────────────────────────────────
    if (action === 'setstatus' && req.method === 'POST') {
      const body = req.body || {};
      const data = await heroCall({ action: 'setStatus', id: body.id, status: body.status });
      return res.json({ result: data });
    }

    // ── DEBUG ────────────────────────────────────────────────
    if (action === 'debug') {
      const results = {};
      try { results.servicesList = await heroCall({ action: 'getServicesList' }); } catch(e) { results.servicesList = e.message; }
      try { results.countries = await heroCall({ action: 'getCountries' }); } catch(e) { results.countries = e.message; }
      try { results.balance = await heroCall({ action: 'getBalance' }); } catch(e) { results.balance = e.message; }
      try { results.prices_sample = await heroCall({ action: 'getPrices', country: '6', service: 'wa' }); } catch(e) { results.prices_sample = e.message; }
      return res.json(results);
    }

    return res.status(404).json({ error: 'Action tidak dikenal: ' + action });

  } catch (e) {
    const msg = e.response?.data || e.message;
    return res.status(500).json({ error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
};
