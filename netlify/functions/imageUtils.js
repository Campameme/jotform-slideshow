// netlify/functions/imageUtils.js
// Shared utilities: authenticated Jotform download + sharp resize + imgbb upload

const fetch = require('node-fetch');
const sharp = require('sharp');

const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// Max width for resized images (px). Keeps quality good while cutting file size 80-90%.
const MAX_WIDTH = 1200;

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
 * Resize image buffer to MAX_WIDTH, convert to JPEG quality 82.
 * Returns base64 string ready for imgbb.
 */
async function resizeAndEncode(imageBuffer) {
    const resized = await sharp(imageBuffer)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true }) // never upscale
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    return resized.toString('base64');
}

/**
 * Upload base64 image to imgbb. Returns permanent public URL.
 */
async function uploadToImgbb(base64) {
    const body = new URLSearchParams();
    body.append('key', IMGBB_API_KEY);
    body.append('image', base64);
    const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(`imgbb: ${JSON.stringify(json)}`);
    return json.data.url;
}

/**
 * Full pipeline: download → resize → upload to imgbb → return permanent URL.
 */
async function processImage(jotformFileUrl) {
    const rawBuffer = await downloadJotformImage(jotformFileUrl);
    const base64 = await resizeAndEncode(rawBuffer);
    return uploadToImgbb(base64);
}

module.exports = { downloadJotformImage, resizeAndEncode, uploadToImgbb, processImage };
