// netlify/functions/sync.js
// Fetches ALL Jotform submissions, uploads missing images to imgbb, saves to JSONBin.
// Call GET /.netlify/functions/sync to trigger a backfill.

const fetch = require('node-fetch');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const JOTFORM_FORM_ID = '260555247643056';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
};

// ── JSONBin ────────────────────────────────────────────────────────────────────
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

// ── Jotform API ────────────────────────────────────────────────────────────────
async function getJotformSubmissions() {
    const url = `https://api.jotform.com/form/${JOTFORM_FORM_ID}/submissions?apiKey=${JOTFORM_API_KEY}&limit=1000&orderby=created_at`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Jotform API error: ${res.status}`);
    const json = await res.json();
    return json.content || [];
}

// ── Download image with API key auth ──────────────────────────────────────────
async function downloadImage(fileUrl) {
    const urlWithKey = fileUrl + (fileUrl.includes('?') ? '&' : '?') + 'apiKey=' + JOTFORM_API_KEY;
    const res = await fetch(urlWithKey, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.startsWith('image/')) {
        throw new Error(`Cannot download image (${ct})`);
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
}

// ── imgbb upload ───────────────────────────────────────────────────────────────
async function uploadToImgbb(base64) {
    const body = new URLSearchParams();
    body.append('key', IMGBB_API_KEY);
    body.append('image', base64);
    const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(`imgbb: ${JSON.stringify(json)}`);
    return json.data.url;
}

// ── Handler ────────────────────────────────────────────────────────────────────
exports.handler = async () => {
    try {
        // Load what's already saved
        const existing = await getBin();
        const existingIds = new Set(existing.map(s => s.submissionId).filter(Boolean));

        // Get all Jotform submissions
        const jotformSubs = await getJotformSubmissions();
        console.log(`Jotform submissions: ${jotformSubs.length}, already saved: ${existing.length}`);

        const results = { processed: 0, skipped: 0, failed: 0, errors: [] };
        const newEntries = [];

        for (const sub of jotformSubs) {
            const subId = sub.id;
            if (existingIds.has(subId)) { results.skipped++; continue; }

            // Find name and file URL from answers
            const answers = sub.answers || {};
            let name = null;
            let fileUrl = null;

            for (const ans of Object.values(answers)) {
                if (!name && ans.type === 'control_textbox' && ans.answer) {
                    name = String(ans.answer).trim();
                }
                if (!fileUrl && ans.type === 'control_fileupload' && ans.answer) {
                    fileUrl = Array.isArray(ans.answer) ? ans.answer[0] : ans.answer;
                }
            }

            if (!fileUrl) { results.skipped++; continue; }

            try {
                const base64 = await downloadImage(fileUrl);
                const imageUrl = await uploadToImgbb(base64);
                newEntries.push({
                    name,
                    imageUrl,
                    submissionId: subId,
                    timestamp: sub.created_at,
                });
                results.processed++;
                console.log(`✓ Processed submission ${subId}: ${name}`);
            } catch (err) {
                results.failed++;
                results.errors.push(`${subId}: ${err.message}`);
                console.error(`✗ Failed ${subId}:`, err.message);
            }
        }

        // Prepend new entries (newest first from Jotform, so reverse to keep order)
        if (newEntries.length > 0) {
            const allEntries = [...newEntries.reverse(), ...existing];
            await updateBin(allEntries);
        }

        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({ ...results, total: existing.length + newEntries.length }),
        };
    } catch (err) {
        console.error('Sync error:', err);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
};
