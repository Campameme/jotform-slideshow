// netlify/functions/like.js
const fetch = require('node-fetch');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
    }

    try {
        const { submissionId } = JSON.parse(event.body);
        if (!submissionId) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'submissionId is required' }) };
        }

        // 1. Get latest data from JSONBin
        const getRes = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_API_KEY, 'X-Bin-Meta': 'false' },
        });

        if (!getRes.ok) throw new Error(`JSONBin Fetch: ${getRes.status}`);
        const submissions = await getRes.json();

        if (!Array.isArray(submissions)) {
            return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Data is not an array' }) };
        }

        // 2. Increment like count for the target submission
        let newLikes = 0;
        let found = false;
        const updated = submissions.map(s => {
            if (s.submissionId === submissionId) {
                s.likes = (s.likes || 0) + 1;
                newLikes = s.likes;
                found = true;
            }
            return s;
        });

        if (!found) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Submission not found' }) };
        }

        // 3. Save back to JSONBin
        const putRes = await fetch(`${JSONBIN_BASE}/b/${JSONBIN_BIN_ID}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
            body: JSON.stringify(updated),
        });

        if (!putRes.ok) throw new Error(`JSONBin Update: ${putRes.status}`);

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: true, likes: newLikes }),
        };

    } catch (err) {
        console.error('Like error:', err);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: err.message }),
        };
    }
};
