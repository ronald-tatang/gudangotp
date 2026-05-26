const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;

async function creditWallet(userId, orderId, amount) {
  const done = await kv.get(`topup:${orderId}:done`);
  if (done) return false;
  const cur = parseInt(await kv.get(`wallet:${userId}:balance`) || 0);
  await kv.set(`wallet:${userId}:balance`, cur + amount);
  await kv.lpush(`wallet:${userId}:txs`, JSON.stringify({
    type: 'topup', orderId, amount,
    description: 'Top Up Saldo via Midtrans',
    status: 'success', createdAt: Date.now(),
  }));
  await kv.ltrim(`wallet:${userId}:txs`, 0, 99);
  await kv.set(`topup:${orderId}:done`, '1', { ex: 86400 * 30 });
  return true;
}

async function creditReseller(apiKey, orderId, amount) {
  const doneKey = `reseller:topup:${orderId}:done`;
  const done    = await kv.get(doneKey);
  if (done) return false;
  const cur = parseInt(await kv.get(`reseller:${apiKey}:balance`) || 0);
  await kv.set(`reseller:${apiKey}:balance`, cur + amount);
  await kv.lpush(`reseller:${apiKey}:txs`, JSON.stringify({
    type: 'topup', orderId, amount,
    description: 'Top Up Saldo Reseller via Midtrans',
    status: 'success', createdAt: Date.now(),
  }));
  await kv.ltrim(`reseller:${apiKey}:txs`, 0, 199);
  await kv.set(doneKey, '1', { ex: 86400 * 30 });
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const notif = req.body;
    const { order_id, status_code, gross_amount, signature_key } = notif;

    // Verifikasi signature Midtrans
    const expected = crypto.createHash('sha512')
      .update(`${order_id}${status_code}${gross_amount}${SERVER_KEY}`)
      .digest('hex');
    if (signature_key !== expected)
      return res.status(403).json({ error: 'Invalid signature' });

    const paid = notif.transaction_status === 'settlement' || notif.transaction_status === 'capture';
    if (!paid) return res.json({ message: `Status ${notif.transaction_status}, skip` });

    const amount = parseInt(gross_amount);

    // ── Top up reseller (order_id: RSL-xxx) ──────────────
    if (order_id.startsWith('RSL-')) {
      const apiKey = notif.custom_field1;
      if (!apiKey) return res.status(400).json({ error: 'apiKey tidak ditemukan di custom_field1' });
      const credited = await creditReseller(apiKey, order_id, amount);
      return res.json({ success: true, type: 'reseller', apiKey, amount, credited });
    }

    // ── Top up user biasa (order_id: TOPUP-xxx) ──────────
    if (order_id.startsWith('TOPUP-')) {
      const userId = notif.custom_field1 || order_id.split('-')[1];
      if (!userId) return res.status(400).json({ error: 'userId tidak ditemukan' });
      const credited = await creditWallet(userId, order_id, amount);
      return res.json({ success: true, type: 'user', userId, amount, credited });
    }

    return res.json({ message: 'Order tidak dikenal, skip' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
