// netlify/functions/proxy.js
// Proxies images from Jotform CDN to bypass hotlink/referrer protection

const fetch = require('node-fetch');

exports.handler = async (event) => {
    const imageUrl = event.queryStringParameters && event.queryStringParameters.url;

    if (!imageUrl) {
        return { statusCode: 400, body: 'Missing ?url= parameter' };
    }

    // Only allow Jotform CDN URLs for security
    if (!imageUrl.startsWith('https://eu.jotform.com/') && !imageUrl.startsWith('https://www.jotform.com/')) {
        return { statusCode: 403, body: 'Forbidden: only Jotform URLs are allowed' };
    }

    try {
        const res = await fetch(imageUrl, {
            headers: {
                // Spoof the referrer so Jotform CDN accepts the request
                'Referer': 'https://www.jotform.com/',
                'User-Agent': 'Mozilla/5.0 (compatible; Netlify-Function)',
            },
        });

        if (!res.ok) {
            return { statusCode: res.status, body: `Upstream error: ${res.status}` };
        }

        const buffer = await res.buffer();
        const contentType = res.headers.get('content-type') || 'image/jpeg';

        return {
            statusCode: 200,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400', // cache 24h
                'Access-Control-Allow-Origin': '*',
            },
            body: buffer.toString('base64'),
            isBase64Encoded: true,
        };
    } catch (err) {
        console.error('Proxy error:', err);
        return { statusCode: 500, body: err.message };
    }
};
