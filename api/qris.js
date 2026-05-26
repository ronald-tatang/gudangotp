// api/qris.js — CASHI.ID (QRIS via create-order)
// Env: CASHI_API_KEY

const axios = require('axios');

const CASHI_API_KEY = process.env.CASHI_API_KEY || 'sk_0997fef664559ef4b97403c4354414ad';
const BASE_URL      = 'https://cashi.id/api';

function cashiHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-api-key'   : CASHI_API_KEY,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'create';

  try {

    // ── CREATE ORDER / QRIS ───────────────────────────────
    if (action === 'create' && req.method === 'POST') {
      const { amount, orderId } = req.body || {};
      if (!amount || !orderId)
        return res.status(400).json({ error: 'amount dan orderId wajib diisi' });

      const body = {
        amount  : parseInt(amount),
        order_id: orderId,
      };

      const { data } = await axios.post(`${BASE_URL}/create-order`, body, {
        headers: cashiHeaders(),
      });

      return res.json({
        orderId       : data.order_id  || orderId,
        transactionId : data.id        || data.transaction_id || '',
        qrUrl         : data.qr_url   || data.qrUrl          || '',
        qrString      : data.qr_code  || data.qrString        || '',
        amount        : parseInt(amount),
        status        : data.status   || 'pending',
        expiry        : data.expired_at || data.expiry || '',
      });
    }

    // ── CHECK STATUS ────────────────────────────────────
    if (action === 'status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const { data } = await axios.get(`${BASE_URL}/check-status?order_id=${orderId}`, {
        headers: cashiHeaders(),
      });

      const status = (data.status || '').toUpperCase();
      const paid   = ['SUCCESS', 'PAID', 'SETTLEMENT', 'COMPLETED'].includes(status);

      return res.json({
        orderId,
        status : data.status,
        paid,
        amount : data.amount,
      });
    }

    return res.status(404).json({ error: 'Action tidak dikenal' });

  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    return res.status(500).json({ error: msg });
  }
};
