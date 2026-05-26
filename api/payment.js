// api/payment.js — CASHI.ID Payment Gateway
// Env: CASHI_API_KEY

const axios = require('axios');

const CASHI_API_KEY = process.env.CASHI_API_KEY || 'CASHI-CFXQ470IQH5';
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'create_order';

  try {

    // ── BUAT ORDER (QRIS / Payment) ─────────────────────────
    if (action === 'create_order' && req.method === 'POST') {
      const { amount, orderId } = req.body || {};
      if (!amount) return res.status(400).json({ error: 'amount wajib diisi' });

      const body = { amount: parseInt(amount) };
      if (orderId) body.order_id = orderId;

      const { data } = await axios.post(`${BASE_URL}/create-order`, body, {
        headers: cashiHeaders(),
      });

      return res.json(data);
    }

    // ── CEK STATUS ──────────────────────────────────────────
    if (action === 'status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const { data } = await axios.get(`${BASE_URL}/check-status?order_id=${orderId}`, {
        headers: cashiHeaders(),
      });

      const status = (data.status || '').toUpperCase();
      const paid   = ['SUCCESS', 'PAID', 'SETTLEMENT', 'COMPLETED'].includes(status);

      return res.json({ ...data, paid });
    }

    return res.status(404).json({ error: 'Action tidak dikenal' });

  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    return res.status(500).json({ error: msg });
  }
};
