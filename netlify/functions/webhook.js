// netlify/functions/webhook.js
// Receives Jotform webhook POST (multipart/form-data) and stores submission in JSONBin.io

const fetch = require('node-fetch');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

/**
 * Decode body: Netlify may base64-encode binary bodies.
 */
function decodeBody(event) {
  if (event.isBase64Encoded && event.body) {
    return Buffer.from(event.body, 'base64').toString('utf-8');
  }
  return event.body || '';
}

/**
 * Parse multipart/form-data into a plain key→value object.
 * Only handles text parts (skips binary file parts).
 */
function parseMultipart(body, boundary) {
  const fields = {};
  const delimiter = '--' + boundary;
  const parts = body.split(delimiter);

  for (const part of parts) {
    if (!part || part === '--\r\n' || part.trim() === '--') continue;

    const headerBodySplit = part.indexOf('\r\n\r\n');
    if (headerBodySplit === -1) continue;

    const headers = part.substring(0, headerBodySplit);
    // Remove trailing \r\n from value
    const value = part.substring(headerBodySplit + 4).replace(/\r\n$/, '');

    const nameMatch = headers.match(/name="([^"]+)"/);
    if (nameMatch) {
      fields[nameMatch[1]] = value;
    }
  }
  return fields;
}

/**
 * Extract name + imageUrl from the parsed multipart fields.
 *
 * Jotform multipart payload includes a `rawRequest` field which is a JSON
 * string containing all form answers + resolved file URLs.
 * Structure (from real log):
 * {
 *   "q3_nomePagina": "tonypitony",
 *   "caricaFile": ["https://eu.jotform.com/uploads/.../logo scritta.png"],
 *   ...
 * }
 */
function extractSubmission(fields) {
  console.log('Multipart field keys:', Object.keys(fields));

  // Parse rawRequest JSON (contains resolved file URLs)
  let raw = {};
  if (fields.rawRequest) {
    try {
      raw = JSON.parse(fields.rawRequest);
      console.log('rawRequest keys:', Object.keys(raw));
    } catch (e) {
      console.error('Failed to parse rawRequest JSON:', e.message);
    }
  }

  // ── Extract name ──────────────────────────────────────────────────────────
  // q3_nomePagina is directly in rawRequest
  const name = raw.q3_nomePagina
    || fields.q3_nomePagina
    || extractFromPretty(fields.pretty, 'Nome pagina')
    || null;

  // ── Extract image URL ──────────────────────────────────────────────────────
  // Jotform puts resolved CDN URLs in rawRequest.caricaFile (array)
  let imageUrl = null;
  if (raw.caricaFile && Array.isArray(raw.caricaFile) && raw.caricaFile.length > 0) {
    imageUrl = raw.caricaFile[0];
  } else if (raw.q4_caricaFile && Array.isArray(raw.q4_caricaFile)) {
    imageUrl = raw.q4_caricaFile[0];
  } else {
    // Fallback: scan fields for anything that looks like a CDN URL
    for (const val of Object.values(fields)) {
      if (typeof val === 'string' && val.includes('jotform.com/uploads')) {
        imageUrl = val;
        break;
      }
    }
  }

  console.log('Extracted → name:', name, '| imageUrl:', imageUrl);
  return { name, imageUrl, timestamp: new Date().toISOString() };
}

function extractFromPretty(pretty, label) {
  if (!pretty) return null;
  const re = new RegExp(label + ':([^,\\n]+)', 'i');
  const m = pretty.match(re);
  return m ? m[1].trim() : null;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = decodeBody(event);
    const contentType = event.headers['content-type'] || '';
    console.log('Content-Type:', contentType);

    let fields = {};

    if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
      if (!boundaryMatch) {
        return { statusCode: 400, body: 'Missing multipart boundary' };
      }
      fields = parseMultipart(body, boundaryMatch[1]);
    } else if (contentType.includes('application/json')) {
      fields = JSON.parse(body);
    } else {
      // form-urlencoded fallback
      const params = new URLSearchParams(body);
      for (const [key, value] of params.entries()) {
        fields[key] = value;
      }
    }

    const submission = extractSubmission(fields);

    if (!submission.name && !submission.imageUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Could not extract name or imageUrl', fields: Object.keys(fields) }),
      };
    }

    // Read current bin
    const getRes = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY, 'X-Bin-Meta': 'false' },
    });

    let submissions = [];
    if (getRes.ok) {
      const json = await getRes.json();
      submissions = Array.isArray(json) ? json.filter(s => !s.init) : [];
    }

    submissions.unshift(submission);

    // Update bin
    const putRes = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
      body: JSON.stringify(submissions),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error('JSONBin PUT error:', errText);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save', detail: errText }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, submission }) };

  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
