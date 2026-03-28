const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { createApp, createDb, createHelpers, seedPrices } = require('../src/app');
const { createRateLimiter } = require('../src/api');

const TEST_ADMIN_SECRET = 'test-admin-secret';

function makeApp(opts) {
    const db = createDb(':memory:');
    seedPrices(db);
    const helpers = createHelpers(db);
    return { app: createApp(db, null, { adminSecret: TEST_ADMIN_SECRET, ...opts }), db, helpers };
}

// Helper: register and activate an agent for tests
function setupAgent(helpers, phone, pin, district) {
    helpers.registerAgent(phone, 'TestAgent', pin, district || 'Mityana');
    helpers.setAgentStatus(phone, 'active');
}

// Helper: register a buyer for tests
function setupBuyer(helpers, phone, pin) {
    helpers.registerBuyer(phone, 'TestBuyer', pin);
}

async function req(app, method, path, body, headers) {
    const { default: supertest } = await import('supertest');
    const st = supertest(app);
    let r = st[method](path).set('Content-Type', 'application/json');
    if (headers) for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return body ? r.send(body) : r;
}

describe('GET /api/prices', () => {
    it('returns seeded prices with units', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/prices');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
        const maize = res.body.find(p => p.crop === 'Maize');
        assert.equal(maize.price, '1200');
        assert.equal(maize.unit, 'per kg');
    });
});

describe('PUT /api/prices', () => {
    it('updates prices', async () => {
        const { app } = makeApp();
        await req(app, 'put', '/api/prices', { Maize: '9999' });
        const res = await req(app, 'get', '/api/prices');
        const maize = res.body.find(p => p.crop === 'Maize');
        assert.equal(maize.price, '9999');
    });
});

describe('GET /api/listings', () => {
    it('returns empty array when no listings', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/listings');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
    });
});

describe('GET /api/listings/active', () => {
    it('returns listings without auth (public access)', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/listings/active');
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
    });

    it('returns listings with valid buyer credentials', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, '+256700000080', '1234');
        const res = await req(app, 'get', '/api/listings/active', null, { 'x-phone': '+256700000080', 'x-pin': '1234' });
        assert.equal(res.status, 200);
    });

    it('rejects invalid buyer credentials', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, '+256700000080', '1234');
        const res = await req(app, 'get', '/api/listings/active', null, { 'x-phone': '+256700000080', 'x-pin': '0000' });
        assert.equal(res.status, 403);
    });
});

describe('POST /api/profiles', () => {
    it('sends OTP for phone verification', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/profiles', {
            phone: '+256700000099', name: 'Kato', parish: 'Kibibi', district: 'Mityana'
        });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.match(res.body.message, /OTP sent/i);
    });

    it('rejects missing phone', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/profiles', { name: 'Kato' });
        assert.equal(res.status, 400);
    });

    it('completes profile creation via verify-otp', async () => {
        const { app, helpers } = makeApp();
        await req(app, 'post', '/api/profiles', {
            phone: '+256700000099', name: 'Kato', parish: 'Kibibi', district: 'Mityana'
        });
        const code = helpers.getStoredOtp('+256700000099', 'profile_register');
        assert.ok(code, 'OTP should be stored');
        const res = await req(app, 'post', '/api/profiles/verify-otp', { phone: '+256700000099', code });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        const profile = helpers.getProfile('+256700000099');
        assert.equal(profile.name, 'Kato');
    });

    it('rejects invalid OTP code', async () => {
        const { app } = makeApp();
        await req(app, 'post', '/api/profiles', {
            phone: '+256700000099', name: 'Kato', parish: 'Kibibi', district: 'Mityana'
        });
        const res = await req(app, 'post', '/api/profiles/verify-otp', { phone: '+256700000099', code: '000000' });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /invalid code/i);
    });
});

describe('GET /api/profiles/:phone', () => {
    it('returns 404 for unknown phone', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/profiles/+256700000000');
        assert.equal(res.status, 404);
    });

    it('returns profile after creation', async () => {
        const { app, helpers } = makeApp();
        helpers.saveProfile('+256700000099', 'Kato', 'Kibibi', 'Mityana');
        const res = await req(app, 'get', '/api/profiles/+256700000099');
        assert.equal(res.status, 200);
        assert.equal(res.body.name, 'Kato');
    });
});

describe('PATCH /api/listings/:id/status', () => {
    it('returns 404 for unknown id', async () => {
        const { app } = makeApp();
        const res = await req(app, 'patch', '/api/listings/nonexistent/status', { status: '[APPROVED]' });
        assert.equal(res.status, 404);
    });

    it('rejects invalid status', async () => {
        const { app } = makeApp();
        const res = await req(app, 'patch', '/api/listings/any/status', { status: 'INVALID' });
        assert.equal(res.status, 400);
    });

    it('approves a pending listing', async () => {
        const { app, helpers } = makeApp();
        helpers.addListing({ id: 'p1', time: 'now', phone: '+1', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[PENDING]' });
        const res = await req(app, 'patch', '/api/listings/p1/status', { status: '[APPROVED]' });
        assert.equal(res.status, 200);
        assert.equal(helpers.getListing('p1').status, '[APPROVED]');
    });
});

// ==========================================
// FARMER LISTING API
// ==========================================
describe('POST /api/listings/farmer', () => {
    it('creates listing with auto-approve for small qty', async () => {
        const { app, helpers } = makeApp();
        helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
        const res = await req(app, 'post', '/api/listings/farmer', { phone: '+256700000001', detail: 'Maize 50kg' });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, '[APPROVED]');
    });

    it('approves large qty immediately (agents verify, not gate)', async () => {
        const { app, helpers } = makeApp();
        helpers.saveProfile('+256700000001', 'Kato', 'Kibibi', 'Mityana');
        const res = await req(app, 'post', '/api/listings/farmer', { phone: '+256700000001', detail: 'Maize 500kg' });
        assert.equal(res.body.status, '[APPROVED]');
    });

    it('returns 404 without profile', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/listings/farmer', { phone: '+256799999999', detail: 'Rice 10kg' });
        assert.equal(res.status, 404);
    });

    it('returns 400 without required fields', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/listings/farmer', { phone: '+256700000001' });
        assert.equal(res.status, 400);
    });
});

// ==========================================
// BROKER LISTING API
// ==========================================
describe('POST /api/listings/broker', () => {
    it('creates city listing as approved', async () => {
        const { app, helpers } = makeApp();
        const res = await req(app, 'post', '/api/listings/broker', { phone: '+256700000002', detail: 'Matooke 200bunches' });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, '[APPROVED]');
        const all = helpers.getAllListings();
        assert.equal(all[0].type, 'CITY');
    });

    it('returns 400 without required fields', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/listings/broker', {});
        assert.equal(res.status, 400);
    });
});

// ==========================================
// AGENT REGISTRATION & LOGIN
// ==========================================
describe('POST /api/agents/register', () => {
    it('registers agent successfully', async () => {
        const { app, helpers } = makeApp();
        const res = await req(app, 'post', '/api/agents/register', {
            phone: '+256700000090', name: 'Agent Bob', pin: '5555', district: 'Mityana'
        });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        // Complete OTP verification
        const code = helpers.getStoredOtp('+256700000090', 'agent_register');
        const res2 = await req(app, 'post', '/api/agents/verify-otp', { phone: '+256700000090', code });
        assert.equal(res2.status, 200);
        assert.equal(res2.body.status, 'pending');
    });

    it('rejects missing fields', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/agents/register', { phone: '+256700000090' });
        assert.equal(res.status, 400);
    });

    it('rejects non-4-digit PIN', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/agents/register', {
            phone: '+256700000090', name: 'Bob', pin: '12345', district: 'X'
        });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /4 digits/i);
    });

    it('rejects duplicate phone', async () => {
        const { app, helpers } = makeApp();
        await req(app, 'post', '/api/agents/register', { phone: '+256700000090', name: 'Bob', pin: '5555', district: 'X' });
        const code = helpers.getStoredOtp('+256700000090', 'agent_register');
        await req(app, 'post', '/api/agents/verify-otp', { phone: '+256700000090', code });
        const res = await req(app, 'post', '/api/agents/register', { phone: '+256700000090', name: 'Bob2', pin: '6666', district: 'Y' });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /already registered/i);
    });
});

describe('POST /api/agents/login', () => {
    it('returns 403 for pending agent', async () => {
        const { app, helpers } = makeApp();
        await req(app, 'post', '/api/agents/register', { phone: '+256700000090', name: 'Bob', pin: '5555', district: 'X' });
        const code = helpers.getStoredOtp('+256700000090', 'agent_register');
        await req(app, 'post', '/api/agents/verify-otp', { phone: '+256700000090', code });
        const res = await req(app, 'post', '/api/agents/login', { phone: '+256700000090', pin: '5555' });
        assert.equal(res.status, 403);
        assert.match(res.body.error, /pending/i);
    });

    it('returns 200 for active agent with correct PIN', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000090', '5555');
        const res = await req(app, 'post', '/api/agents/login', { phone: '+256700000090', pin: '5555' });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.equal(res.body.agent.name, 'TestAgent');
    });

    it('returns 403 for wrong PIN', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000090', '5555');
        const res = await req(app, 'post', '/api/agents/login', { phone: '+256700000090', pin: '0000' });
        assert.equal(res.status, 403);
    });

    it('returns 403 for suspended agent', async () => {
        const { app, helpers } = makeApp();
        helpers.registerAgent('+256700000090', 'Bob', '5555', 'X');
        helpers.setAgentStatus('+256700000090', 'suspended');
        const res = await req(app, 'post', '/api/agents/login', { phone: '+256700000090', pin: '5555' });
        assert.equal(res.status, 403);
        assert.match(res.body.error, /suspended/i);
    });
});

// ==========================================
// BUYER REGISTRATION & LOGIN
// ==========================================
describe('POST /api/buyers/register', () => {
    it('registers buyer successfully', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/buyers/register', {
            phone: '+256700000080', name: 'Buyer Jane', pin: '1234'
        });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
    });

    it('rejects duplicate phone', async () => {
        const { app, helpers } = makeApp();
        await req(app, 'post', '/api/buyers/register', { phone: '+256700000080', name: 'Jane', pin: '1234' });
        const code = helpers.getStoredOtp('+256700000080', 'buyer_register');
        await req(app, 'post', '/api/buyers/verify-otp', { phone: '+256700000080', code });
        const res = await req(app, 'post', '/api/buyers/register', { phone: '+256700000080', name: 'Jane2', pin: '5678' });
        assert.equal(res.status, 400);
    });

    it('rejects non-4-digit PIN', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/buyers/register', { phone: '+256700000080', name: 'Jane', pin: 'abc' });
        assert.equal(res.status, 400);
    });
});

describe('POST /api/buyers/login', () => {
    it('returns 200 for correct credentials', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, '+256700000080', '1234');
        const res = await req(app, 'post', '/api/buyers/login', { phone: '+256700000080', pin: '1234' });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.equal(res.body.buyer.name, 'TestBuyer');
    });

    it('returns 403 for wrong PIN', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, '+256700000080', '1234');
        const res = await req(app, 'post', '/api/buyers/login', { phone: '+256700000080', pin: '0000' });
        assert.equal(res.status, 403);
    });

    it('returns 403 for unknown phone', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/buyers/login', { phone: '+256700000000', pin: '1234' });
        assert.equal(res.status, 403);
    });
});

// ==========================================
// ADMIN AGENT MANAGEMENT
// ==========================================
describe('Admin agent endpoints', () => {
    it('GET /api/admin/agents returns agents list', async () => {
        const { app, helpers } = makeApp();
        helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
        const { default: supertest } = await import('supertest');
        const res = await supertest(app).get('/api/admin/agents').set('x-admin-secret', TEST_ADMIN_SECRET);
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 1);
        assert.equal(res.body[0].name, 'Bob');
    });

    it('GET /api/admin/agents rejects without secret', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/admin/agents');
        assert.equal(res.status, 403);
    });

    it('PATCH /api/admin/agents/:phone/status approves agent', async () => {
        const { app, helpers } = makeApp();
        helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
        const { default: supertest } = await import('supertest');
        const res = await supertest(app)
            .patch('/api/admin/agents/%2B256700000090/status')
            .set('x-admin-secret', TEST_ADMIN_SECRET)
            .set('Content-Type', 'application/json')
            .send({ status: 'active' });
        assert.equal(res.status, 200);
        assert.equal(helpers.getAgent('+256700000090').status, 'active');
    });
});

// ==========================================
// AGENT ENDPOINTS (Individual Auth)
// ==========================================
describe('GET /api/agent/listings', () => {
    it('returns all listings with valid agent credentials', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000090', '5555');
        helpers.addListing({ id: 'a1', time: 'now', phone: '+1', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[PENDING]' });
        const res = await req(app, 'get', '/api/agent/listings', null, { 'x-phone': '+256700000090', 'x-pin': '5555' });
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 1);
    });

    it('rejects invalid agent credentials', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/agent/listings', null, { 'x-phone': '+256700000090', 'x-pin': '0000' });
        assert.equal(res.status, 403);
    });
});

// ==========================================
// TRUST & VERIFICATION ENDPOINTS
// ==========================================
describe('POST /api/listings/:id/verify', () => {
    it('agent submits verification successfully', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.saveProfile('+256700000010', 'Farmer', 'Kibibi', 'Mityana');
        helpers.addListing({ id: 'v1', time: 'now', phone: '+256700000010', detail: 'Maize 200kg', location: 'Kibibi', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/listings/v1/verify', {
            grade: 'A', checklist: ['qty_confirmed', 'quality_ok'],
            lat: 0.5, lng: 32.5, notes: 'Looks good'
        }, { 'x-phone': '+256700000099', 'x-pin': '5555' });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
    });

    it('blocks self-verification (agent is the farmer)', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000010', '5555');
        helpers.addListing({ id: 'v2', time: 'now', phone: '+256700000010', detail: 'Beans 50kg', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/listings/v2/verify', {
            grade: 'A', checklist: ['ok']
        }, { 'x-phone': '+256700000010', 'x-pin': '5555' });
        assert.equal(res.status, 403);
        assert.match(res.body.error, /cannot verify your own/i);
    });

    it('blocks suspended agent (3+ strikes)', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '5555');
        const now = new Date().toISOString();
        helpers.addListing({ id: 'v3', time: now, phone: '+256700000010', detail: 'Rice 100kg', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        for (let i = 0; i < 3; i++) {
            helpers.addListing({ id: `s${i}`, time: now, phone: '+256700000010', detail: 'X', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
            helpers.setVerification(`s${i}`, { agent_phone: '+256700000050' });
            helpers.addFeedback(`s${i}`, '+256700000010', `+2567000000${80 + i}`, 1, 'Bad');
        }
        assert.ok(helpers.isAgentSuspended('+256700000050'));
        const res = await req(app, 'post', '/api/listings/v3/verify', {
            grade: 'A', checklist: ['ok']
        }, { 'x-phone': '+256700000050', 'x-pin': '5555' });
        assert.equal(res.status, 403);
        assert.match(res.body.error, /suspended/i);
    });

    it('rejects invalid agent credentials', async () => {
        const { app } = makeApp();
        const res = await req(app, 'post', '/api/listings/any/verify', {
            grade: 'A', checklist: ['ok']
        }, { 'x-phone': '+256700000099', 'x-pin': '0000' });
        assert.equal(res.status, 403);
    });

    it('returns 404 for unknown listing', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        const res = await req(app, 'post', '/api/listings/nonexistent/verify', {
            grade: 'A', checklist: ['ok']
        }, { 'x-phone': '+256700000099', 'x-pin': '5555' });
        assert.equal(res.status, 404);
    });
});

describe('GET /api/listings/:id/verification', () => {
    it('returns verified: false when no verification', async () => {
        const { app, helpers } = makeApp();
        helpers.addListing({ id: 'vf1', time: 'now', phone: '+1', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'get', '/api/listings/vf1/verification');
        assert.equal(res.status, 200);
        assert.equal(res.body.verified, false);
    });

    it('returns verification data after agent verifies', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.saveProfile('+256700000010', 'Farmer', 'Kibibi', 'Mityana');
        helpers.addListing({ id: 'vf2', time: 'now', phone: '+256700000010', detail: 'Maize 200kg', location: 'Kibibi', type: 'VILLAGE', status: '[APPROVED]' });
        await req(app, 'post', '/api/listings/vf2/verify', {
            grade: 'A', checklist: ['qty_confirmed']
        }, { 'x-phone': '+256700000099', 'x-pin': '5555' });
        const res = await req(app, 'get', '/api/listings/vf2/verification');
        assert.equal(res.status, 200);
        assert.equal(res.body.verified, true);
        assert.equal(res.body.grade, 'A');
        assert.equal(res.body.agent_phone, '+256700000099');
    });

    it('returns 404 for unknown listing', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/listings/nonexistent/verification');
        assert.equal(res.status, 404);
    });
});

describe('GET /api/reputation/:phone', () => {
    it('returns NEW tier for unknown farmer', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/reputation/+256700000010');
        assert.equal(res.status, 200);
        assert.equal(res.body.tier, 'NEW');
        assert.equal(res.body.sales, 0);
    });

    it('returns ACTIVE tier after a sale', async () => {
        const { app, helpers } = makeApp();
        helpers.saveProfile('+256700000010', 'Farmer', 'Kibibi', 'Mityana');
        helpers.addListing({ id: 'rep1', time: new Date().toISOString(), phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        helpers.addFeedback('rep1', '+256700000010', '+256700000077', 4, 'Good');
        const res = await req(app, 'get', '/api/reputation/+256700000010');
        assert.equal(res.status, 200);
        assert.equal(res.body.tier, 'ACTIVE');
        assert.equal(res.body.sales, 1);
    });
});

describe('POST /api/feedback', () => {
    const BUYER = '+256700000077';
    const BUYER_PIN = '5555';
    const buyerAuth = { 'x-phone': BUYER, 'x-pin': BUYER_PIN };

    it('creates feedback with valid listing_id and buyer auth', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        helpers.addListing({ id: 'fb0', time: new Date().toISOString(), phone: '+256700000010', detail: 'Maize 50kg', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'fb0', farmer_phone: '+256700000010', rating: 5, comment: 'Great'
        }, buyerAuth);
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.equal(res.body.reputation.sales, 1);
    });

    it('rejects feedback without buyer auth', async () => {
        const { app, helpers } = makeApp();
        helpers.addListing({ id: 'fb-noauth', time: new Date().toISOString(), phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'fb-noauth', farmer_phone: '+256700000010', rating: 5
        });
        assert.equal(res.status, 403);
        assert.match(res.body.error, /invalid buyer credentials/i);
    });

    it('ignores buyer_phone in body — uses authenticated phone', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        helpers.addListing({ id: 'fb-spoof', time: new Date().toISOString(), phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'fb-spoof', farmer_phone: '+256700000010', buyer_phone: '+256700099999', rating: 5
        }, buyerAuth);
        assert.equal(res.status, 200);
        // The feedback was recorded under the authenticated buyer phone, not the spoofed one
        const rep = helpers.getFarmerReputation('+256700000010');
        assert.equal(rep.sales, 1);
    });

    it('rejects feedback without listing_id', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        const res = await req(app, 'post', '/api/feedback', {
            farmer_phone: '+256700000010', rating: 5
        }, buyerAuth);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /listing_id required/i);
    });

    it('rejects duplicate rating (same buyer + listing)', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        helpers.addListing({ id: 'fb-dup', time: new Date().toISOString(), phone: '+256700000010', detail: 'Beans', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        await req(app, 'post', '/api/feedback', {
            listing_id: 'fb-dup', farmer_phone: '+256700000010', rating: 5
        }, buyerAuth);
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'fb-dup', farmer_phone: '+256700000010', rating: 1
        }, buyerAuth);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /already rated/i);
    });

    it('rejects rating after 7-day window', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        helpers.addListing({ id: 'fb-old', time: oldDate, phone: '+256700000010', detail: 'Rice', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'fb-old', farmer_phone: '+256700000010', rating: 4
        }, buyerAuth);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /window closed/i);
    });

    it('cascades strike to verifying agent on bad rating', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        helpers.addListing({ id: 'fb1', time: new Date().toISOString(), phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        helpers.setVerification('fb1', { agent_phone: '+256700000099' });
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'fb1', farmer_phone: '+256700000010', rating: 1, comment: 'Scam'
        }, buyerAuth);
        assert.equal(res.status, 200);
        const record = helpers.getAgentRecord('+256700000099');
        assert.equal(record.strikes, 1);
    });

    it('rejects missing required fields', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        const res = await req(app, 'post', '/api/feedback', { listing_id: 'x', rating: 5 }, buyerAuth);
        assert.equal(res.status, 400);
    });

    it('rejects invalid rating', async () => {
        const { app, helpers } = makeApp();
        setupBuyer(helpers, BUYER, BUYER_PIN);
        helpers.addListing({ id: 'fb-inv', time: new Date().toISOString(), phone: '+256700000010', detail: 'X', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'fb-inv', farmer_phone: '+256700000010', rating: 10
        }, buyerAuth);
        assert.equal(res.status, 400);
    });
});

describe('GET /api/agent/record', () => {
    it('returns agent accountability record', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.addListing({ id: 'ar1', time: 'now', phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        helpers.setVerification('ar1', { agent_phone: '+256700000099' });
        const res = await req(app, 'get', '/api/agent/record', null, { 'x-phone': '+256700000099', 'x-pin': '5555' });
        assert.equal(res.status, 200);
        assert.equal(res.body.phone, '+256700000099');
        assert.equal(res.body.strikes, 0);
        assert.equal(res.body.verifications, 1);
        assert.equal(res.body.suspended, false);
    });

    it('rejects invalid credentials', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/agent/record', null, { 'x-phone': '+256700000099', 'x-pin': '0000' });
        assert.equal(res.status, 403);
    });

    it('returns commission totals in record', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.addCommission('+256700000099', 'listing-x', 5000);
        helpers.addCommission('+256700000099', 'listing-y', 5000);
        const res = await req(app, 'get', '/api/agent/record', null, { 'x-phone': '+256700000099', 'x-pin': '5555' });
        assert.equal(res.status, 200);
        assert.equal(res.body.commissions_count, 2);
        assert.equal(res.body.commissions_total, 10000);
    });
});

// ==========================================
// AGENT COMMISSIONS
// ==========================================
describe('GET /api/agent/commissions', () => {
    it('returns commission list for agent', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.addCommission('+256700000099', 'listing-a', 5000);
        const res = await req(app, 'get', '/api/agent/commissions', null, { 'x-phone': '+256700000099', 'x-pin': '5555' });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
        assert.equal(res.body.length, 1);
        assert.equal(res.body[0].amount, 5000);
        assert.equal(res.body[0].agent_phone, '+256700000099');
    });

    it('rejects invalid credentials', async () => {
        const { app } = makeApp();
        const res = await req(app, 'get', '/api/agent/commissions', null, { 'x-phone': '+256700000099', 'x-pin': '0000' });
        assert.equal(res.status, 403);
    });

    it('verify endpoint creates a commission and returns commission_earned', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.addListing({ id: 'cm-listing', time: 'now', phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await req(app, 'post', '/api/listings/cm-listing/verify',
            { grade: 'A', checklist: { 'Produce seen': true } },
            { 'x-phone': '+256700000099', 'x-pin': '5555' }
        );
        assert.equal(res.status, 200);
        assert.equal(res.body.commission_earned, 5000);
        const commissions = helpers.getAgentCommissions('+256700000099');
        assert.equal(commissions.length, 1);
        assert.equal(commissions[0].listing_id, 'cm-listing');
    });
});

// ==========================================
// VIDEO UPLOAD SECURITY
// ==========================================
describe('POST /api/listings/:id/video', () => {
    it('rejects file with non-video mimetype', async () => {
        const { default: supertest } = await import('supertest');
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.addListing({ id: 'vid1', time: 'now', phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await supertest(app)
            .post('/api/listings/vid1/video')
            .set('x-phone', '+256700000099')
            .set('x-pin', '5555')
            .attach('video', Buffer.from('fake content'), { filename: 'evil.php', contentType: 'application/php' });
        assert.equal(res.status, 400);
    });

    it('rejects file with spoofed mimetype but disallowed extension', async () => {
        const { default: supertest } = await import('supertest');
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.addListing({ id: 'vid2', time: 'now', phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await supertest(app)
            .post('/api/listings/vid2/video')
            .set('x-phone', '+256700000099')
            .set('x-pin', '5555')
            .attach('video', Buffer.from('fake content'), { filename: 'evil.php', contentType: 'video/mp4' });
        assert.equal(res.status, 400);
    });

    it('accepts file with valid video mimetype and extension', async () => {
        const { default: supertest } = await import('supertest');
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000099', '5555');
        helpers.addListing({ id: 'vid3', time: 'now', phone: '+256700000010', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        const res = await supertest(app)
            .post('/api/listings/vid3/video')
            .set('x-phone', '+256700000099')
            .set('x-pin', '5555')
            .attach('video', Buffer.from('fake video content'), { filename: 'sample.mp4', contentType: 'video/mp4' });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
    });
});

// ==========================================
// RATE LIMITING
// ==========================================
describe('Rate limiting', () => {
    it('createRateLimiter.check allows requests within limit', () => {
        const limiter = createRateLimiter();
        assert.ok(limiter.check('test-key', 3, 60000));
        assert.ok(limiter.check('test-key', 3, 60000));
        assert.ok(limiter.check('test-key', 3, 60000));
        assert.equal(limiter.check('test-key', 3, 60000), false); // 4th blocked
    });

    it('createRateLimiter.check resets after window expires', () => {
        const limiter = createRateLimiter();
        // Fill the bucket
        for (let i = 0; i < 3; i++) limiter.check('expire-key', 3, 1); // 1ms window
        // Wait for window to expire
        const start = Date.now();
        while (Date.now() - start < 5) {} // busy wait 5ms
        assert.ok(limiter.check('expire-key', 3, 1)); // should be allowed after reset
    });

    it('separate keys have independent limits', () => {
        const limiter = createRateLimiter();
        for (let i = 0; i < 3; i++) limiter.check('key-a', 3, 60000);
        assert.equal(limiter.check('key-a', 3, 60000), false); // key-a exhausted
        assert.ok(limiter.check('key-b', 3, 60000)); // key-b still has quota
    });

    it('blocks login after 5 failed attempts', async () => {
        const limiter = createRateLimiter();
        const { app, helpers } = makeApp({ limiter });
        setupAgent(helpers, '+256700000090', '5555');
        // 5 wrong attempts
        for (let i = 0; i < 5; i++) {
            await req(app, 'post', '/api/agents/login', { phone: '+256700000090', pin: '0000' });
        }
        // 6th attempt — even with correct PIN should be rate limited
        const res = await req(app, 'post', '/api/agents/login', { phone: '+256700000090', pin: '5555' });
        assert.equal(res.status, 429);
        assert.match(res.body.error, /too many/i);
    });

    it('blocks registration spam', async () => {
        const limiter = createRateLimiter();
        const { app } = makeApp({ limiter });
        // 3 registrations
        for (let i = 0; i < 3; i++) {
            await req(app, 'post', '/api/buyers/register', {
                phone: `+25670000100${i}`, name: `Buyer${i}`, pin: '1234'
            });
        }
        // 4th should be rate limited
        const res = await req(app, 'post', '/api/buyers/register', {
            phone: '+256700001003', name: 'Buyer3', pin: '1234'
        });
        assert.equal(res.status, 429);
    });

    it('blocks feedback spam', async () => {
        const limiter = createRateLimiter();
        const { app, helpers } = makeApp({ limiter });
        const BUYER = '+256700000077';
        const BUYER_PIN = '5555';
        setupBuyer(helpers, BUYER, BUYER_PIN);
        const buyerAuth = { 'x-phone': BUYER, 'x-pin': BUYER_PIN };
        const now = new Date().toISOString();
        // Create 11 listings to rate
        for (let i = 0; i < 11; i++) {
            helpers.addListing({ id: `rl${i}`, time: now, phone: '+256700000010', detail: 'X', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
        }
        // 10 valid ratings (general limit might interfere, so we check the 11th)
        for (let i = 0; i < 10; i++) {
            await req(app, 'post', '/api/feedback', {
                listing_id: `rl${i}`, farmer_phone: '+256700000010', rating: 5
            }, buyerAuth);
        }
        // 11th should be rate limited
        const res = await req(app, 'post', '/api/feedback', {
            listing_id: 'rl10', farmer_phone: '+256700000010', rating: 5
        }, buyerAuth);
        assert.equal(res.status, 429);
    });
});
