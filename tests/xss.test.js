const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createDb, createApp, createHelpers, seedPrices } = require('../src/app');

function get(app, path) {
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            http.get(`http://localhost:${port}${path}`, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { server.close(); resolve(data); });
            });
        });
    });
}

describe('Dashboard XSS protection', () => {
    let db, app, helpers;

    beforeEach(() => {
        db = createDb(':memory:');
        seedPrices(db);
        helpers = createHelpers(db);
        app = createApp(db, null);
    });

    it('escapes HTML in listing details', async () => {
        helpers.addListing({ id: '1', time: 'now', phone: '+256700000000', detail: '<script>alert("xss")</script>', location: 'Kibibi', type: 'VILLAGE', status: '[APPROVED]' });
        const html = await get(app, '/');
        assert.ok(!html.includes('<script>alert("xss")</script>'));
        assert.ok(html.includes('&lt;script&gt;'));
    });

    it('escapes HTML in phone numbers', async () => {
        helpers.addListing({ id: '2', time: 'now', phone: '"><script>x</script>', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const html = await get(app, '/');
        assert.ok(!html.includes('"><script>x</script>'));
        assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
    });

    it('escapes HTML in crop names for price inputs', async () => {
        helpers.setPrices({ '<img onerror=alert(1)>': '1000' });
        const html = await get(app, '/');
        assert.ok(!html.includes('<img onerror=alert(1)>'));
        assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
    });
});
