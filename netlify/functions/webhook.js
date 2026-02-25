// netlify/functions/webhook.js
// Receives Jotform webhook, downloads image, re-uploads to imgbb (permanent CDN), saves to JSONBin

const fetch = require('node-fetch');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

// ── Decode body (Netlify may base64-encode binary bodies) ─────────────────────
function decodeBody(event) {
  if (event.isBase64Encoded && event.body) {
    return Buffer.from(event.body, 'base64').toString('utf-8');
  }
  return event.body || '';
}

// ── Parse multipart/form-data into key→value map ─────────────────────────────
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

// ── Extract name + Jotform image URL from parsed fields ──────────────────────
function extractFields(fields) {
  let raw = {};
  if (fields.rawRequest) {
    try { raw = JSON.parse(fields.rawRequest); } catch (e) { }
  }
  const name = raw.q3_nomePagina || fields.q3_nomePagina || null;
  let jotformUrl = null;
  if (raw.caricaFile && Array.isArray(raw.caricaFile) && raw.caricaFile.length > 0) {
    jotformUrl = raw.caricaFile[0];
  }
  return { name, jotformUrl };
}

// ── Download image from Jotform CDN (authenticated via API key) ──────────────
async function downloadImage(jotformUrl, submissionId) {
  const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;

  // Strategy 1: append apiKey to the CDN URL (works if Jotform supports it)
  const urlWithKey = jotformUrl + (jotformUrl.includes('?') ? '&' : '?') + 'apiKey=' + JOTFORM_API_KEY;
  console.log('Trying authenticated CDN URL…');
  const res1 = await fetch(urlWithKey, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });
  const ct1 = res1.headers.get('content-type') || '';
  console.log('Strategy 1 Content-Type:', ct1);

  if (res1.ok && ct1.startsWith('image/')) {
    const buf = await res1.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  }

  // Strategy 2: use Jotform API to get submission file URL, then download
  if (submissionId && JOTFORM_API_KEY) {
    console.log('Trying Jotform API submission endpoint…');
    const apiRes = await fetch(
      `https://api.jotform.com/submission/${submissionId}?apiKey=${JOTFORM_API_KEY}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (apiRes.ok) {
      const apiJson = await apiRes.json();
      // Find file URL in answers
      const answers = apiJson.content && apiJson.content.answers ? apiJson.content.answers : {};
      for (const ans of Object.values(answers)) {
        if (ans.type === 'control_fileupload' && ans.answer) {
          const fileUrl = Array.isArray(ans.answer) ? ans.answer[0] : ans.answer;
          console.log('API file URL:', fileUrl);
          const fileRes = await fetch(fileUrl + '?apiKey=' + JOTFORM_API_KEY, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            redirect: 'follow',
          });
          const fileCt = fileRes.headers.get('content-type') || '';
          console.log('API file Content-Type:', fileCt);
          if (fileRes.ok && fileCt.startsWith('image/')) {
            const buf = await fileRes.arrayBuffer();
            return Buffer.from(buf).toString('base64');
          }
        }
      }
    }
  }

  throw new Error(`Could not download image from Jotform. Content-Type was: ${ct1}`);
}


// ── Upload base64 image to imgbb → returns permanent public URL ───────────────
async function uploadToImgbb(base64Image) {
  const body = new URLSearchParams();
  body.append('key', IMGBB_API_KEY);
  body.append('image', base64Image);

  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`imgbb upload failed: ${JSON.stringify(json)}`);
  }
  return json.data.url; // permanent public URL
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
  const res = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
    body: JSON.stringify(submissions),
  });
  return res.ok;
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

    console.log('Downloading image from Jotform…');
    const base64 = await downloadImage(jotformUrl, submissionId);

    console.log('Uploading to imgbb…');
    const imageUrl = await uploadToImgbb(base64);
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
