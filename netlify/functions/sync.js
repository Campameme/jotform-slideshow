// netlify/functions/sync.js
// Backfills Jotform submissions to JSONBin via imgbb, with batch processing to avoid timeouts.
// GET /.netlify/functions/sync?offset=0&limit=5

const fetch = require('node-fetch');
const { processImage } = require('./imageUtils');

const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const JOTFORM_FORM_ID = '260555247643056';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';
const BATCH_SIZE = 5; // process this many per call to stay within 10s timeout

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
};

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

async function getJotformSubmissions() {
    // Account is on EU server — must use api.eu.jotform.com
    const url = `https://eu-api.jotform.com/form/${JOTFORM_FORM_ID}/submissions?apiKey=${JOTFORM_API_KEY}&limit=1000&orderby=created_at`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Jotform API ${res.status}`);
    const json = await res.json();
    console.log('Jotform API response code:', json.responseCode, '| count:', json.resultSet && json.resultSet.count);
    return json.content || [];
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    try {
        const params = event.queryStringParameters || {};
        const offset = parseInt(params.offset || '0', 10);
        const limit = parseInt(params.limit || String(BATCH_SIZE), 10);

        // 1. Fetch current data from both sources
        const existing = await getBin();
        const jotformSubs = await getJotformSubmissions();

        // 2. PRUNE: Remove submissions from JSONBin that are no longer ACTIVE in Jotform
        const activeJotformIds = new Set(jotformSubs.filter(s => s.status === 'ACTIVE').map(s => s.id));
        const pruned = existing.filter(s => {
            if (!s.submissionId) return true; // keep init or legacy items without ID
            return activeJotformIds.has(s.submissionId);
        });

        const removedCount = existing.length - pruned.length;
        if (removedCount > 0) {
            console.log(`Pruning: removing ${removedCount} stale submissions from JSONBin`);
            await updateBin(pruned);
        }

        // 3. ADD MISSING: Continue with existing logic to add new active submissions
        const existingIds = new Set(pruned.map(s => s.submissionId).filter(Boolean));
        console.log(`Jotform submissions: ${jotformSubs.length}, active in bin: ${pruned.length}, querying offset=${offset}`);

        // Filter to only missing AND active submissions
        const missing = jotformSubs.filter(sub => {
            const isActive = sub.status === 'ACTIVE';
            const isMissing = !existingIds.has(sub.id);
            return isActive && isMissing;
        });
        console.log(`Missing and Active (to be added): ${missing.length}`);

        const batch = missing.slice(offset, offset + limit);
        const hasMore = offset + limit < missing.length;

        const results = { processed: 0, failed: 0, errors: [], removed: removedCount };
        const newEntries = [];

        for (const sub of batch) {
            const answers = sub.answers || {};
            let name = null;
            let fileUrl = null;

            for (const ans of Object.values(answers)) {
                if (!name && ans.type === 'control_textbox' && ans.answer) name = String(ans.answer).trim();
                if (!fileUrl && ans.type === 'control_fileupload' && ans.answer) fileUrl = Array.isArray(ans.answer) ? ans.answer[0] : ans.answer;
            }

            if (!fileUrl) { console.log(`Skipping ${sub.id} — no file`); continue; }

            try {
                const imageUrl = await processImage(fileUrl); // download → resize → imgbb
                newEntries.push({ name, imageUrl, submissionId: sub.id, timestamp: sub.created_at });
                results.processed++;
                console.log(`✓ ${sub.id} → ${imageUrl}`);
            } catch (err) {
                results.failed++;
                results.errors.push(`${sub.id}: ${err.message}`);
                console.error(`✗ ${sub.id}:`, err.message);
            }
        }

        if (newEntries.length > 0) {
            // Re-fetch bin to get latest (including possible recent pruning)
            const latestBin = await getBin();
            const latestIds = new Set(latestBin.map(s => s.submissionId).filter(Boolean));
            const toAdd = newEntries.filter(e => !latestIds.has(e.submissionId));
            await updateBin([...toAdd, ...latestBin]);
        }

        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
                ...results,
                totalMissing: missing.length,
                offset,
                hasMore,
                nextOffset: hasMore ? offset + limit : null,
            }),
        };
    } catch (err) {
        console.error('Sync error:', err);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
};
