// netlify/functions/webhook.js
// Receives Jotform webhook, downloads+resizes image, re-uploads to imgbb, saves to JSONBin

const fetch = require('node-fetch');
const { processImage } = require('./imageUtils');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

// ── Decode body ───────────────────────────────────────────────────────────────
function decodeBody(event) {
  if (event.isBase64Encoded && event.body) return Buffer.from(event.body, 'base64').toString('utf-8');
  return event.body || '';
}

// ── Parse multipart/form-data ─────────────────────────────────────────────────
function parseMultipart(body, boundary) {
  const fields = {};
  const parts = body.split('--' + boundary);
  for (const part of parts) {
    if (!part || part.trim() === '--') continue;
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const headers = part.substring(0, split);
    const value = part.substring(split + 4).replace(/\r\n$/, '');
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (nameMatch) fields[nameMatch[1]] = value;
  }
  return fields;
}

// ── Extract name + Jotform image URL ─────────────────────────────────────────
function extractFields(fields) {
  let raw = {};
  if (fields.rawRequest) { try { raw = JSON.parse(fields.rawRequest); } catch (e) { } }
  const name = raw.q3_nomePagina || fields.q3_nomePagina || null;
  let jotformUrl = null;
  if (raw.caricaFile && Array.isArray(raw.caricaFile) && raw.caricaFile.length > 0) {
    jotformUrl = raw.caricaFile[0];
  }
  return { name, jotformUrl };
}

// ── JSONBin helpers ───────────────────────────────────────────────────────────
async function getBin() {
  const res = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_API_KEY, 'X-Bin-Meta': 'false' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data.filter(s => !s.init) : [];
}

async function updateBin(submissions) {
  await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
    body: JSON.stringify(submissions),
  });
}


// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse multipart payload from Jotform
    const body = decodeBody(event);
    const contentType = event.headers['content-type'] || '';
    let fields = {};

    if (contentType.includes('multipart/form-data')) {
      const m = contentType.match(/boundary=([^\s;]+)/);
      if (m) fields = parseMultipart(body, m[1]);
    } else if (contentType.includes('application/json')) {
      fields = JSON.parse(body);
    } else {
      const params = new URLSearchParams(body);
      for (const [k, v] of params.entries()) fields[k] = v;
    }

    const { name, jotformUrl } = extractFields(fields);
    const submissionId = fields.submissionID || null;
    console.log('Extracted → name:', name, '| jotformUrl:', jotformUrl, '| submissionId:', submissionId);

    if (!jotformUrl) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No image URL found in payload' }) };
    }

    console.log('Processing image (download → resize → imgbb)…');
    const imageUrl = await processImage(jotformUrl);
    console.log('imgbb URL:', imageUrl);

    // Save to JSONBin
    const submissions = await getBin();
    // Avoid duplicates: skip if submissionId already exists
    if (submissionId && submissions.some(s => s.submissionId === submissionId)) {
      return { statusCode: 200, body: JSON.stringify({ success: true, skipped: true, reason: 'duplicate' }) };
    }
    submissions.unshift({ name, imageUrl, submissionId, timestamp: new Date().toISOString() });
    await updateBin(submissions);

    return { statusCode: 200, body: JSON.stringify({ success: true, imageUrl }) };

  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
