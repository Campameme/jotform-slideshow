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
    // Add cache buster to avoid edge caching
    const url = `https://eu-api.jotform.com/form/${JOTFORM_FORM_ID}/submissions?apiKey=${JOTFORM_API_KEY}&limit=1000&orderby=created_at&cb=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Jotform API ${res.status}`);
    const json = await res.json();
    console.log('Jotform API response:', json.responseCode, '| count:', json.resultSet && json.resultSet.count);
    return json.content || [];
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

    try {
        const params = event.queryStringParameters || {};
        const offset = parseInt(params.offset || '0', 10);
        const limit = parseInt(params.limit || String(BATCH_SIZE), 10);

        // 1. Fetch current data
        const existingEntries = await getBin();
        const jotformSubs = await getJotformSubmissions();

        // 2. Identify Active Jotform Submissions (Case-insensitive check)
        const activeJotformMap = new Map();
        jotformSubs.forEach(sub => {
            const status = String(sub.status || '').toUpperCase();
            if (status === 'ACTIVE') {
                activeJotformMap.set(sub.id, sub);
            }
        });

        console.log(`Jotform: ${jotformSubs.length} total, ${activeJotformMap.size} active.`);

        // 3. PRUNE: Identify entries in JSONBin that are no longer ACTIVE in Jotform
        const prunedEntries = existingEntries.filter(entry => {
            if (!entry.submissionId) return true; // Keep metadata/header items if any
            const stillActive = activeJotformMap.has(entry.submissionId);
            if (!stillActive) console.log(`Pruning stale submission: ${entry.submissionId}`);
            return stillActive;
        });

        const removedCount = existingEntries.length - prunedEntries.length;
        const currentIdsInBin = new Set(prunedEntries.map(e => e.submissionId).filter(Boolean));

        // 4. IDENTIFY MISSING: Active on Jotform but not in Bin
        const missingFromBin = [];
        jotformSubs.forEach(sub => {
            if (String(sub.status).toUpperCase() === 'ACTIVE' && !currentIdsInBin.has(sub.id)) {
                missingFromBin.push(sub);
            }
        });

        console.log(`Summary: ${prunedEntries.length} entries kept, ${removedCount} removed, ${missingFromBin.length} missing and to be added.`);

        // 5. PROCESS BATCH
        const batch = missingFromBin.slice(offset, offset + limit);
        const hasMore = offset + limit < missingFromBin.length;
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

            if (!fileUrl) continue;

            try {
                const imageUrl = await processImage(fileUrl);
                newEntries.push({
                    name,
                    imageUrl,
                    submissionId: sub.id,
                    timestamp: sub.created_at,
                    likes: 0 // Initialize likes for new entries
                });
                results.processed++;
                console.log(`✓ Added: ${sub.id}`);
            } catch (err) {
                results.failed++;
                results.errors.push(`${sub.id}: ${err.message}`);
                console.error(`✗ Failed ${sub.id}:`, err.message);
            }
        }

        // 6. SINGLE UPDATE: Save everything (pruned + new batch) in one go to prevent race conditions
        if (newEntries.length > 0 || removedCount > 0) {
            // Refetch bin to get the absolute latest state (including recently added likes)
            // and merge again to minimize overwrite risks
            const latestBin = await getBin();

            // Re-apply pruning on the latest data
            const finalPruned = latestBin.filter(e => {
                if (!e.submissionId) return true;
                return activeJotformMap.has(e.submissionId);
            });

            // Filter new entries that might have been added in the meantime
            const finalIds = new Set(finalPruned.map(e => e.submissionId).filter(Boolean));
            const filteredNewEntries = newEntries.filter(e => !finalIds.has(e.submissionId));

            await updateBin([...filteredNewEntries, ...finalPruned]);
            console.log(`Bin updated successfully. Total items: ${filteredNewEntries.length + finalPruned.length}`);
        }

        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
                ...results,
                totalMissing: missingFromBin.length,
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
