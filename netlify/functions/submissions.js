// netlify/functions/submissions.js
// Returns all submissions stored in JSONBin.io

const fetch = require('node-fetch');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
    }

    try {
        const res = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest`, {
            headers: {
                'X-Master-Key': JSONBIN_API_KEY,
                'X-Bin-Meta': 'false',
            },
        });

        if (!res.ok) {
            const errText = await res.text();
            return {
                statusCode: res.status,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: 'JSONBin error', detail: errText }),
            };
        }

        const data = await res.json();
        // Filter out the init placeholder and any entry without an imageUrl
        const submissions = Array.isArray(data)
            ? data.filter(s => s && s.imageUrl && !s.init)
            : [];

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify(submissions),
        };
    } catch (err) {
        console.error('Submissions fetch error:', err);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: err.message }),
        };
    }
};
