// netlify/functions/imageUtils.js
// Shared utilities: authenticated Jotform download + imgbb upload
// NOTE: No native image processing libraries (sharp incompatible with NFT bundler).
// Images are uploaded as-is to imgbb which serves them via CDN.

const fetch = require('node-fetch');

const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

/**
 * Download an image from Jotform CDN using API key auth.
 * Returns a Buffer.
 */
async function downloadJotformImage(fileUrl) {
    const urlWithKey = fileUrl + (fileUrl.includes('?') ? '&' : '?') + 'apiKey=' + JOTFORM_API_KEY;
    const res = await fetch(urlWithKey, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
    });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.startsWith('image/')) {
        throw new Error(`Jotform CDN returned non-image (${res.status} ${ct})`);
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
}

/**
 * Upload image buffer to imgbb. Returns permanent public URL.
 */
async function uploadToImgbb(imageBuffer) {
    const base64 = imageBuffer.toString('base64');
    const body = new URLSearchParams();
    body.append('key', IMGBB_API_KEY);
    body.append('image', base64);
    const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(`imgbb: ${JSON.stringify(json)}`);
    return json.data.url;
}

/**
 * Full pipeline: download from Jotform → upload to imgbb → return permanent URL.
 */
async function processImage(jotformFileUrl) {
    const buffer = await downloadJotformImage(jotformFileUrl);
    return uploadToImgbb(buffer);
}

module.exports = { downloadJotformImage, uploadToImgbb, processImage };
