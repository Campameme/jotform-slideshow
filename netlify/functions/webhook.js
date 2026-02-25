// netlify/functions/webhook.js
// Receives Jotform webhook POST and stores submission in JSONBin.io

const fetch = require('node-fetch');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

function parseFormData(body) {
  // Parse application/x-www-form-urlencoded body
  const params = new URLSearchParams(body);
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return data;
}

function extractSubmission(data) {
  /**
   * Jotform sends webhook data as form-urlencoded with keys like:
   *   q3_nomePagina = "Mario Rossi"
   *   q4_caricaImmagine[0] = "https://cdn.jotfor.ms/..."
   *   pretty = "Nome pagina:Mario Rossi"
   *
   * We extract the name (first short-text field) and image URL (first file array field).
   * This approach is flexible regardless of exact question IDs.
   */

  let name = null;
  let imageUrl = null;
  const timestamp = new Date().toISOString();

  // Log raw data for debugging (visible in Netlify Function logs)
  console.log('Jotform webhook payload keys:', Object.keys(data));

  for (const [key, value] of Object.entries(data)) {
    // Skip metadata fields
    if (['formID', 'submissionID', 'webhookURL', 'ip', 'pretty', 'slug'].includes(key)) continue;
    if (key === 'submit' || key === '') continue;

    // File upload fields: key ends with [0] or similar, value is a URL
    if (key.endsWith('[0]') && value && (value.startsWith('https://') || value.startsWith('http://'))) {
      if (!imageUrl) imageUrl = value;
    }
    // Text field: simple q{n}_{label} key with a short string value
    else if (!key.includes('[') && value && value.trim() !== '' && !name) {
      // Skip if it looks like another URL
      if (!value.startsWith('http')) {
        name = value.trim();
      }
    }
  }

  // Fallback: try "pretty" field if parsing failed
  if (!name && data.pretty) {
    const match = data.pretty.match(/Nome pagina:([^,\n]+)/i) || data.pretty.match(/Name:([^,\n]+)/i);
    if (match) name = match[1].trim();
  }

  return { name, imageUrl, timestamp };
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse the incoming payload
    const contentType = event.headers['content-type'] || '';
    let data = {};

    if (contentType.includes('application/json')) {
      data = JSON.parse(event.body || '{}');
    } else {
      // Default: form-urlencoded (Jotform default)
      data = parseFormData(event.body || '');
    }

    const submission = extractSubmission(data);
    console.log('Parsed submission:', submission);

    if (!submission.name && !submission.imageUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Could not extract name or image from payload', raw: data }),
      };
    }

    // Fetch current submissions from JSONBin
    const getRes = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest`, {
      headers: {
        'X-Master-Key': JSONBIN_API_KEY,
        'X-Bin-Meta': 'false',
      },
    });

    let submissions = [];
    if (getRes.ok) {
      const json = await getRes.json();
      submissions = Array.isArray(json) ? json : [];
    }

    // Prepend new submission (newest first)
    submissions.unshift(submission);

    // Update JSONBin with new list
    const putRes = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_API_KEY,
      },
      body: JSON.stringify(submissions),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error('JSONBin PUT error:', errText);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save submission', detail: errText }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, submission }),
    };
  } catch (err) {
    console.error('Webhook error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
