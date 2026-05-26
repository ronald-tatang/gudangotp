// api/payment.js — DOKU Direct API (VA + QRIS)
// Credentials via environment variables:
//   DOKU_CLIENT_ID
//   DOKU_SECRET_KEY

const axios  = require('axios');
const crypto = require('crypto');

const CLIENT_ID  = process.env.DOKU_CLIENT_ID  || 'BRN-0237-1777463752367';
const SECRET_KEY = process.env.DOKU_SECRET_KEY || 'SK-wGd4nsgWHODTAyM8Yfow';
const BASE_URL   = 'https://api.doku.com';

// ── Signature HMAC-SHA256 ─────────────────────────────────
function makeSignature(requestId, timestamp, body) {
  const component = `${CLIENT_ID}:${requestId}:${timestamp}:${body}`;
  return 'HMACSHA256=' + crypto
    .createHmac('sha256', SECRET_KEY)
    .update(component)
    .digest('base64');
}

function dokuHeaders(requestId, timestamp, body) {
  return {
    'Content-Type'      : 'application/json',
    'Client-Id'         : CLIENT_ID,
    'Request-Id'        : requestId,
    'Request-Timestamp' : timestamp,
    'Signature'         : makeSignature(requestId, timestamp, body),
  };
}

function nowTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

function requestId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'create_va';

  try {

    // ── BUAT VIRTUAL ACCOUNT ────────────────────────────────
    if (action === 'create_va' && req.method === 'POST') {
      const { amount, orderId, customerName, customerEmail, channel } = req.body || {};
      if (!amount || !orderId || !channel)
        return res.status(400).json({ error: 'amount, orderId, channel wajib diisi' });

      const rid  = requestId();
      const ts   = nowTimestamp();
      const body = JSON.stringify({
        order: {
          invoice_number: orderId,
          line_items: [{ name: 'Top Up Saldo VIRNOM', price: parseInt(amount), quantity: 1 }],
          amount  : parseInt(amount),
          currency: 'IDR',
          session_id: orderId,
        },
        virtual_account_info: {
          billing_type   : 'FIX_BILL',
          expired_time   : 60,
          reusable_status: false,
          info1          : 'Top Up Saldo VIRNOM',
        },
        customer: {
          name : customerName  || 'Pengguna VIRNOM',
          email: customerEmail || 'user@virnom.app',
        },
      });

      const { data } = await axios.post(
        `${BASE_URL}/virtual-accounts/${channel}/payment`,
        body,
        { headers: dokuHeaders(rid, ts, body) }
      );

      const vaInfo = data.virtual_account_info || {};
      return res.json({
        orderId,
        vaNumber : vaInfo.virtual_account_number || '',
        bank     : channel.replace('_VA', ''),
        amount   : parseInt(amount),
        expiredAt: vaInfo.expired_date || '',
        type     : 'VA',
      });
    }

    // ── BUAT QRIS ───────────────────────────────────────────
    if (action === 'create_qris' && req.method === 'POST') {
      const { amount, orderId, customerName, customerEmail } = req.body || {};
      if (!amount || !orderId)
        return res.status(400).json({ error: 'amount dan orderId wajib diisi' });

      const rid  = requestId();
      const ts   = nowTimestamp();
      const body = JSON.stringify({
        order: {
          invoice_number: orderId,
          line_items: [{ name: 'Top Up Saldo VIRNOM', price: parseInt(amount), quantity: 1 }],
          amount  : parseInt(amount),
          currency: 'IDR',
        },
        customer: {
          name : customerName  || 'Pengguna VIRNOM',
          email: customerEmail || 'user@virnom.app',
        },
        additional_info: { type: 'QR_CODE' },
      });

      const { data } = await axios.post(
        `${BASE_URL}/qris/v2/payment`,
        body,
        { headers: dokuHeaders(rid, ts, body) }
      );

      const qr = data.qr || {};
      return res.json({
        orderId,
        qrString: qr.qr_string || '',
        qrUrl   : qr.qr_url    || '',
        amount  : parseInt(amount),
        type    : 'QRIS',
      });
    }

    // ── CEK STATUS ──────────────────────────────────────────
    if (action === 'status') {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

      const rid = requestId();
      const ts  = nowTimestamp();

      const { data } = await axios.get(
        `${BASE_URL}/orders/${orderId}/status`,
        { headers: dokuHeaders(rid, ts, '') }
      );

      const status = (data.transaction?.status || '').toUpperCase();
      return res.json({
        orderId,
        paid  : status === 'SUCCESS',
        status,
        amount: data.order?.amount,
      });
    }

    return res.status(404).json({ error: 'Action tidak dikenal' });

  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    return res.status(500).json({ error: msg });
  }
};
