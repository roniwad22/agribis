const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createDb, createApp, createHelpers, seedPrices } = require('../src/app');

function postUssd(app, body) {
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const postData = new URLSearchParams(body).toString();
            const req = http.request({
                hostname: 'localhost', port, path: '/ussd', method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { server.close(); resolve(data); });
            });
            req.write(postData);
            req.end();
        });
    });
}

describe('USSD endpoint', () => {
    let db, app, helpers;

    beforeEach(() => {
        db = createDb(':memory:');
        seedPrices(db);
        helpers = createHelpers(db);
        app = createApp(db, null);
    });

    // ==========================================
    // MAIN MENU
    // ==========================================
    describe('Main Menu', () => {
        it('shows main menu when text is empty', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000000', text: '' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Agri-Bridge'));
            assert.ok(res.includes('1. I am a Farmer'));
            assert.ok(res.includes('4. Check Market Prices'));
            assert.ok(res.includes('5. My Listings'));
            assert.ok(res.includes('6. Rate a Seller'));
        });
    });

    describe('My Listings', () => {
        it('shows no listings for new user', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000099', text: '5' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('no listings'));
        });

        it('shows farmer own listings', async () => {
            helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
            helpers.addListing({ id: 'ml1', time: 'now', phone: '+256700000001', detail: 'Maize 50kg', location: 'Kibibi', type: 'VILLAGE', status: '[APPROVED]' });
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '5' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('Maize 50kg'));
            assert.ok(res.includes('[UNVERIFIED]'));
        });
    });

    // ==========================================
    // FARMER FLOW
    // ==========================================
    describe('Farmer Flow', () => {
        it('prompts registration when no profile', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '1' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Register'));
            assert.ok(res.includes('Name-Parish-District'));
        });

        it('shows listing menu when profile exists', async () => {
            helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '1' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Welcome back, Kato'));
            assert.ok(res.includes('List Produce'));
        });

        it('rejects registration without dash separator', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '1*JustAName' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Invalid format'));
        });

        it('registers with valid input and continues session', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '1*Kato-Kibibi-Mityana' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Profile Created'));
            const p = helpers.getProfile('+256700000001');
            assert.equal(p.name, 'Kato');
            assert.equal(p.parish, 'Kibibi');
            assert.equal(p.district, 'Mityana');
        });

        it('prompts for crop and quantity', async () => {
            helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '1*1' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Crop & Qty'));
        });

        it('approves listing for small quantity immediately', async () => {
            helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '1*1*Maize 50kg' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('LIVE'));
            const listings = helpers.getAllListings();
            assert.equal(listings.length, 1);
            assert.equal(listings[0].status, '[APPROVED]');
        });

        it('approves large quantity and flags for verification', async () => {
            helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
            const res = await postUssd(app, { phoneNumber: '+256700000001', text: '1*1*Maize 500kg' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('LIVE'));
            assert.ok(res.includes('field agent'));
            const listings = helpers.getAllListings();
            assert.equal(listings[0].status, '[APPROVED]');
        });

        it('generates unique listing IDs', async () => {
            helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
            await postUssd(app, { phoneNumber: '+256700000001', text: '1*1*Maize 10kg' });
            await postUssd(app, { phoneNumber: '+256700000001', text: '1*1*Beans 20kg' });
            const listings = helpers.getAllListings();
            assert.equal(listings.length, 2);
            assert.notEqual(listings[0].id, listings[1].id);
            // IDs should be UUIDs (36 chars with dashes)
            assert.match(listings[0].id, /^[0-9a-f-]{36}$/);
        });
    });

    // ==========================================
    // BROKER FLOW
    // ==========================================
    describe('Broker Flow', () => {
        it('shows broker menu', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000002', text: '2' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Broker Menu'));
        });

        it('prompts for crop and quantity', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000002', text: '2*1' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Crop & Qty'));
        });

        it('creates city listing', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000002', text: '2*1*Matooke 500bunches' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('City wholesale stock is live'));
            const listings = helpers.getAllListings();
            assert.equal(listings.length, 1);
            assert.equal(listings[0].type, 'CITY');
            assert.equal(listings[0].status, '[APPROVED]');
        });
    });

    // ==========================================
    // BUYER FLOW (Individual Registration)
    // ==========================================
    describe('Buyer Flow', () => {
        it('shows buyer menu with browse and register options', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Browse Listings'));
            assert.ok(res.includes('Register'));
        });

        it('shows market selection for browse', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*1' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Farm Gate'));
            assert.ok(res.includes('City Markets'));
        });

        it('prompts for PIN after market selection', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*1*1' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('PIN'));
        });

        it('rejects unregistered buyer', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*1*1*0000' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('Invalid PIN') || res.includes('not registered'));
        });

        it('shows no listings for registered buyer when empty', async () => {
            helpers.registerBuyer('+256700000003', 'TestBuyer', '1234');
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*1*1*1234' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('No active listings'));
        });

        it('shows approved village listings with trust labels', async () => {
            helpers.registerBuyer('+256700000003', 'TestBuyer', '1234');
            helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
            helpers.addListing({ id: 'v1', time: 'now', phone: '+256700000001', detail: 'Maize 50kg', location: 'Kibibi', type: 'VILLAGE', status: '[APPROVED]' });
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*1*1*1234' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('Market Listings'));
            assert.ok(res.includes('Maize 50kg'));
            assert.ok(res.includes('Mityana'));
            assert.ok(res.includes('[Registered'));
            assert.ok(!res.includes('+256700000001'));
        });

        it('shows approved city listings', async () => {
            helpers.registerBuyer('+256700000003', 'TestBuyer', '1234');
            helpers.addListing({ id: 'c1', time: 'now', phone: '+256700000002', detail: 'Matooke 200', location: 'City Market', type: 'CITY', status: '[APPROVED]' });
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*1*2*1234' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('Matooke 200'));
        });
    });

    // ==========================================
    // BUYER REGISTRATION (USSD)
    // ==========================================
    describe('Buyer Registration', () => {
        it('asks for name', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*2' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('name'));
        });

        it('asks for PIN after name', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*2*Kato' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('PIN'));
        });

        it('asks to confirm PIN', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*2*Kato*5678' });
            assert.ok(res.startsWith('CON'));
            assert.ok(res.includes('Confirm'));
        });

        it('rejects non-4-digit PIN', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*2*Kato*abc' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('4 digits'));
        });

        it('registers successfully when PINs match', async () => {
            // Step 1: submit PINs — triggers OTP send
            const otpPrompt = await postUssd(app, { phoneNumber: '+256700000003', text: '3*2*Kato*5678*5678' });
            assert.ok(otpPrompt.startsWith('CON'));
            // Step 2: retrieve stored OTP and submit it
            const code = helpers.getStoredOtp('+256700000003', 'buyer_ussd');
            assert.ok(code);
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: `3*2*Kato*5678*5678*${code}` });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes('Registered'));
            const buyer = helpers.getBuyer('+256700000003');
            assert.equal(buyer.name, 'Kato');
        });

        it('rejects when PINs do not match', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000003', text: '3*2*Kato*5678*9999' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes("don't match"));
        });
    });

    // ==========================================
    // PRICE CHECK
    // ==========================================
    describe('Price Check', () => {
        it('shows seeded prices with units', async () => {
            const res = await postUssd(app, { phoneNumber: '+256700000004', text: '4' });
            assert.ok(res.startsWith('END'));
            assert.ok(res.includes("Today's Prices"));
            assert.ok(res.includes('Maize: 1200 per kg'));
            assert.ok(res.includes('Beans: 3500 per kg'));
            assert.ok(res.includes('Matooke: 25000 per bunch'));
        });

        it('shows updated prices', async () => {
            helpers.setPrices({ Maize: '2000' });
            const res = await postUssd(app, { phoneNumber: '+256700000004', text: '4' });
            assert.ok(res.includes('Maize: 2000 per kg'));
        });
    });
});
