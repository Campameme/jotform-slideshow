// netlify/functions/proxy.js
// Proxies images from Jotform CDN server-side to bypass hotlink/referrer restrictions

const fetch = require('node-fetch');

exports.handler = async (event) => {
    const imageUrl = event.queryStringParameters && event.queryStringParameters.url;

    if (!imageUrl) {
        return { statusCode: 400, body: 'Missing ?url= parameter' };
    }

    // Security: only allow Jotform CDN URLs
    const allowed = ['https://eu.jotform.com/', 'https://www.jotform.com/', 'https://api.jotform.com/'];
    if (!allowed.some(prefix => imageUrl.startsWith(prefix))) {
        return { statusCode: 403, body: 'Forbidden: only Jotform URLs allowed' };
    }

    try {
        const res = await fetch(decodeURIComponent(imageUrl), {
            headers: {
                'Referer': 'https://www.jotform.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        if (!res.ok) {
            return { statusCode: res.status, body: `CDN error: ${res.status}` };
        }

        // Use arrayBuffer for better compatibility across Node versions
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Netlify Functions have a ~6MB response limit — skip proxy for very large files
        if (buffer.length > 5 * 1024 * 1024) {
            // For large files, issue a redirect so the browser tries directly
            return {
                statusCode: 302,
                headers: { Location: imageUrl },
                body: '',
            };
        }

        const contentType = res.headers.get('content-type') || 'image/jpeg';

        return {
            statusCode: 200,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400',
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
