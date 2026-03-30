const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { createApp, createDb, createHelpers, seedPrices } = require('../src/app');
const { createRateLimiter } = require('../src/api');

const TEST_ADMIN_SECRET = 'test-admin-secret';

function makeApp(opts) {
    const db = createDb(':memory:');
    seedPrices(db);
    const helpers = createHelpers(db);
    return { app: createApp(db, null, { adminSecret: TEST_ADMIN_SECRET, sandbox: false, ...opts }), db, helpers };
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
        assert.ok(res2.body.success);
        // Agent should be pending when not in sandbox mode
        const agent = helpers.getAgent('+256700000090');
        assert.equal(agent.status, 'pending');
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

// ==========================================
// PURCHASE LEDGER
// ==========================================
describe('POST /api/agent/purchases', () => {
    it('logs a purchase and returns total price', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Farmer Kato', 'Kibibi', 'Mityana');
        const agentAuth = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        const res = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200, price_unit: 'per kg', grade: 'A', moisture_level: 13.5
        }, agentAuth);
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.equal(res.body.purchase.total_price, 120000);
    });

    it('rejects without auth', async () => {
        const { app, helpers } = makeApp();
        helpers.saveProfile('+256700000051', 'Farmer', 'K', 'M');
        const res = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200
        });
        assert.equal(res.status, 403);
    });

    it('rejects when farmer not registered', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        const res = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000099', crop: 'Maize', quantity_kg: 100, unit_price: 1200
        }, { 'x-phone': '+256700000050', 'x-pin': '1234' });
        assert.equal(res.status, 404);
    });

    it('rejects missing required fields', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Farmer', 'K', 'M');
        const res = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize'
        }, { 'x-phone': '+256700000050', 'x-pin': '1234' });
        assert.equal(res.status, 400);
    });
});

describe('GET /api/agent/purchases', () => {
    it('returns agent purchase history', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Farmer', 'K', 'M');
        const agentAuth = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200
        }, agentAuth);
        const res = await req(app, 'get', '/api/agent/purchases', null, agentAuth);
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 1);
        assert.equal(res.body[0].crop, 'Maize');
    });

    it('filters unbatched purchases', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Farmer', 'K', 'M');
        const agentAuth = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200
        }, agentAuth);
        const res = await req(app, 'get', '/api/agent/purchases?unbatched=true', null, agentAuth);
        assert.equal(res.status, 200);
        assert.equal(res.body.length, 1);
        assert.ok(!res.body[0].batch_id);
    });
});

// ==========================================
// BATCHES
// ==========================================
describe('POST /api/agent/batches', () => {
    it('creates a batch from purchases', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Farmer A', 'K', 'M');
        helpers.saveProfile('+256700000052', 'Farmer B', 'L', 'M');
        const agentAuth = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        const p1 = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200, grade: 'A', moisture_level: 13
        }, agentAuth);
        const p2 = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000052', crop: 'Maize', quantity_kg: 200, unit_price: 1100, grade: 'B', moisture_level: 15
        }, agentAuth);
        const res = await req(app, 'post', '/api/agent/batches', {
            crop: 'Maize', purchase_ids: [p1.body.purchase.id, p2.body.purchase.id]
        }, agentAuth);
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.equal(res.body.batch.total_quantity_kg, 300);
        assert.equal(res.body.batch.overall_grade, 'B'); // lowest grade wins
        assert.ok(res.body.batch.batch_code.startsWith('MIT'));
    });

    it('rejects empty purchase list', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        const res = await req(app, 'post', '/api/agent/batches', {
            crop: 'Maize', purchase_ids: []
        }, { 'x-phone': '+256700000050', 'x-pin': '1234' });
        assert.equal(res.status, 400);
    });

    it('rejects already-batched purchases', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Farmer', 'K', 'M');
        const agentAuth = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        const p1 = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200
        }, agentAuth);
        await req(app, 'post', '/api/agent/batches', {
            crop: 'Maize', purchase_ids: [p1.body.purchase.id]
        }, agentAuth);
        // Try to batch the same purchase again
        const res = await req(app, 'post', '/api/agent/batches', {
            crop: 'Maize', purchase_ids: [p1.body.purchase.id]
        }, agentAuth);
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('already in a batch'));
    });
});

describe('GET /api/batches/:id/trace', () => {
    it('returns traceability certificate with farmer details', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Kato', 'Kibibi', 'Mityana');
        helpers.saveProfile('+256700000052', 'Amina', 'Nkozi', 'Mpigi');
        const agentAuth = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        const p1 = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Beans', quantity_kg: 50, unit_price: 3500, grade: 'A', moisture_level: 12
        }, agentAuth);
        const p2 = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000052', crop: 'Beans', quantity_kg: 80, unit_price: 3400, grade: 'A', moisture_level: 13
        }, agentAuth);
        const batch = await req(app, 'post', '/api/agent/batches', {
            crop: 'Beans', purchase_ids: [p1.body.purchase.id, p2.body.purchase.id]
        }, agentAuth);
        const res = await req(app, 'get', `/api/batches/${batch.body.batch.id}/trace`);
        assert.equal(res.status, 200);
        assert.equal(res.body.crop, 'Beans');
        assert.equal(res.body.total_quantity_kg, 130);
        assert.equal(res.body.farmers.length, 2);
        assert.equal(res.body.farmers[0].name, 'Kato');
        assert.equal(res.body.farmers[1].name, 'Amina');
    });
});

describe('POST /api/batches/:id/sell', () => {
    it('records batch sale and calculates margin', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        helpers.saveProfile('+256700000051', 'Farmer', 'K', 'M');
        const agentAuth = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        const p1 = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200
        }, agentAuth);
        const batch = await req(app, 'post', '/api/agent/batches', {
            crop: 'Maize', purchase_ids: [p1.body.purchase.id]
        }, agentAuth);
        const res = await req(app, 'post', `/api/batches/${batch.body.batch.id}/sell`, {
            sale_price: 150000, buyer_phone: '+256700000060'
        }, agentAuth);
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.equal(res.body.cost_basis, 120000);
        assert.equal(res.body.sale_price, 150000);
        assert.equal(res.body.margin, 30000);
        assert.equal(res.body.platform_fee, 3000); // 10% of margin
    });

    it('rejects selling another agents batch', async () => {
        const { app, helpers } = makeApp();
        setupAgent(helpers, '+256700000050', '1234', 'Mityana');
        setupAgent(helpers, '+256700000055', '5678', 'Kampala');
        helpers.saveProfile('+256700000051', 'Farmer', 'K', 'M');
        const agentAuth1 = { 'x-phone': '+256700000050', 'x-pin': '1234' };
        const agentAuth2 = { 'x-phone': '+256700000055', 'x-pin': '5678' };
        const p1 = await req(app, 'post', '/api/agent/purchases', {
            farmer_phone: '+256700000051', crop: 'Maize', quantity_kg: 100, unit_price: 1200
        }, agentAuth1);
        const batch = await req(app, 'post', '/api/agent/batches', {
            crop: 'Maize', purchase_ids: [p1.body.purchase.id]
        }, agentAuth1);
        const res = await req(app, 'post', `/api/batches/${batch.body.batch.id}/sell`, {
            sale_price: 150000
        }, agentAuth2);
        assert.equal(res.status, 403);
    });
});

// ==========================================
// ESCROW MARKETPLACE TESTS
// ==========================================

// Helper: create batch and set it to 'closed' status (createBatch forces 'open')
function makeClosedBatch(helpers, db, id, agentPhone) {
    helpers.createBatch({ id, agent_phone: agentPhone, batch_code: 'B-' + id, crop: 'Maize', total_quantity_kg: 100, purchase_count: 1, created_at: new Date().toISOString() });
    db.prepare("UPDATE batches SET status = 'closed' WHERE id = ?").run(id);
    return id;
}

describe('Escrow: dispatch requires driver_phone and truck_plate_number', () => {
    it('blocks dispatch without driver_phone', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700100001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-drv1', '+256700100001');
        setupBuyer(helpers, '+256700100002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700100002', 500000);
        helpers.lockEscrow(esc.id, 'MOMO_123');
        const result = helpers.dispatchEscrow(esc.id, '+256700100001', '', 'UAB 123X');
        assert.ok(result.error);
        assert.ok(result.error.includes('Driver phone'));
    });

    it('blocks dispatch without truck_plate_number', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700100003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-drv2', '+256700100003');
        setupBuyer(helpers, '+256700100004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700100004', 300000);
        helpers.lockEscrow(esc.id, 'MOMO_456');
        const result = helpers.dispatchEscrow(esc.id, '+256700100003', '0771234567', '');
        assert.ok(result.error);
        assert.ok(result.error.includes('Truck plate'));
    });

    it('succeeds with both driver_phone and truck_plate_number', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700100005', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-drv3', '+256700100005');
        setupBuyer(helpers, '+256700100006', '5678');
        const esc = helpers.createEscrow(batchId, '+256700100006', 400000);
        helpers.lockEscrow(esc.id, 'MOMO_789');
        const result = helpers.dispatchEscrow(esc.id, '+256700100005', '0771234567', 'uab 456y');
        assert.ok(!result.error);
        assert.equal(result.status, 'IN_TRANSIT');
        assert.equal(result.driver_phone, '0771234567');
        assert.equal(result.truck_plate_number, 'UAB 456Y');
    });
});

describe('Escrow: partial dispute resolution', () => {
    it('admin resolves with partial split', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700200001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-part1', '+256700200001');
        setupBuyer(helpers, '+256700200002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700200002', 1000000);
        helpers.lockEscrow(esc.id, 'MOMO_P1');
        helpers.dispatchEscrow(esc.id, '+256700200001', '0771111111', 'UAB 999Z');
        helpers.disputeEscrow(esc.id, '+256700200002', 'Grade 2 instead of Grade 1');
        const result = helpers.adminResolveEscrow(esc.id, 'partial', 'Quality discount', 80);
        assert.ok(result.success);
        assert.equal(result.action, 'partial');
        assert.equal(result.release_percentage, 80);
        assert.equal(result.released_amount, 760000);
        assert.equal(result.refunded_amount, 190000);
    });

    it('rejects partial without release_percentage', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700200003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-part2', '+256700200003');
        setupBuyer(helpers, '+256700200004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700200004', 500000);
        helpers.lockEscrow(esc.id, 'MOMO_P2');
        helpers.dispatchEscrow(esc.id, '+256700200003', '0772222222', 'UBA 111A');
        helpers.disputeEscrow(esc.id, '+256700200004', 'Short weight');
        const result = helpers.adminResolveEscrow(esc.id, 'partial', 'test');
        assert.ok(result.error);
        assert.ok(result.error.includes('release_percentage'));
    });

    it('rejects invalid release_percentage (>100)', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700200005', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-part3', '+256700200005');
        setupBuyer(helpers, '+256700200006', '5678');
        const esc = helpers.createEscrow(batchId, '+256700200006', 600000);
        helpers.lockEscrow(esc.id, 'MOMO_P3');
        helpers.dispatchEscrow(esc.id, '+256700200005', '0773333333', 'UBA 222B');
        helpers.disputeEscrow(esc.id, '+256700200006', 'Damaged');
        const result = helpers.adminResolveEscrow(esc.id, 'partial', 'test', 150);
        assert.ok(result.error);
    });
});

describe('Escrow: 72h stale threshold', () => {
    it('does not flag escrow locked less than 72h ago', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700300001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-stale1', '+256700300001');
        setupBuyer(helpers, '+256700300002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700300002', 200000);
        helpers.lockEscrow(esc.id, 'MOMO_S1');
        const stale = helpers.getStaleEscrows();
        assert.equal(stale.filter(s => s.id === esc.id).length, 0);
    });

    it('flags escrow locked more than 72h ago', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700300003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-stale2', '+256700300003');
        setupBuyer(helpers, '+256700300004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700300004', 300000);
        helpers.lockEscrow(esc.id, 'MOMO_S2');
        const oldTime = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE escrow_transactions SET locked_at = ? WHERE id = ?').run(oldTime, esc.id);
        const stale = helpers.getStaleEscrows();
        assert.ok(stale.some(s => s.id === esc.id));
    });
});

describe('Escrow: full happy path with driver details', () => {
    it('create -> lock -> dispatch(driver+plate) -> release', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700400001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-happy', '+256700400001');
        setupBuyer(helpers, '+256700400002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700400002', 1000000);
        assert.equal(esc.status, 'PENDING_PAYMENT');
        assert.equal(esc.platform_fee, 50000);
        assert.equal(esc.agent_payout, 950000);

        const locked = helpers.lockEscrow(esc.id, 'MOMO_HAPPY');
        assert.equal(locked.status, 'FUNDS_LOCKED');

        const dispatched = helpers.dispatchEscrow(esc.id, '+256700400001', '0779876543', 'UAX 789Z');
        assert.equal(dispatched.status, 'IN_TRANSIT');
        assert.equal(dispatched.driver_phone, '0779876543');
        assert.equal(dispatched.truck_plate_number, 'UAX 789Z');

        const released = helpers.releaseEscrow(esc.id, '+256700400002');
        assert.equal(released.status, 'RELEASED');
    });

    it('agent cannot release funds', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700400003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-norel', '+256700400003');
        setupBuyer(helpers, '+256700400004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700400004', 500000);
        helpers.lockEscrow(esc.id, 'MOMO_NR');
        helpers.dispatchEscrow(esc.id, '+256700400003', '0771111111', 'UAB 111A');
        const result = helpers.releaseEscrow(esc.id, '+256700400003');
        assert.ok(result.error);
        assert.ok(result.error.includes('Not your escrow'));
    });
});

// ==========================================
// LAYER 3: ADMIN OPS CENTER TESTS
// ==========================================

describe('Escrow: 4-hour cancel window', () => {
    it('allows cancel within 4 hours', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700500001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-4h1', '+256700500001');
        setupBuyer(helpers, '+256700500002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700500002', 500000);
        helpers.lockEscrow(esc.id, 'MOMO_4H1');
        // locked just now — within 4h
        const result = helpers.cancelEscrow(esc.id, '+256700500002');
        assert.ok(!result.error);
        assert.equal(result.status, 'CANCELLED');
    });

    it('blocks cancel after 4 hours', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700500003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-4h2', '+256700500003');
        setupBuyer(helpers, '+256700500004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700500004', 500000);
        helpers.lockEscrow(esc.id, 'MOMO_4H2');
        // backdate locked_at to 5 hours ago
        const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE escrow_transactions SET locked_at = ? WHERE id = ?').run(old, esc.id);
        const result = helpers.cancelEscrow(esc.id, '+256700500004');
        assert.ok(result.error);
        assert.ok(result.error.includes('Cancel window expired'));
    });

    it('admin can still cancel after 4 hours', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700500005', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-4h3', '+256700500005');
        setupBuyer(helpers, '+256700500006', '5678');
        const esc = helpers.createEscrow(batchId, '+256700500006', 500000);
        helpers.lockEscrow(esc.id, 'MOMO_4H3');
        const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE escrow_transactions SET locked_at = ? WHERE id = ?').run(old, esc.id);
        const result = helpers.cancelEscrow(esc.id, 'ADMIN');
        assert.ok(!result.error);
        assert.equal(result.status, 'CANCELLED');
    });
});

describe('Escrow: 24h dispatch SLA', () => {
    it('detects escrows needing 20h warning SMS', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700600001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-sla1', '+256700600001');
        setupBuyer(helpers, '+256700600002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700600002', 300000);
        helpers.lockEscrow(esc.id, 'MOMO_SLA1');
        // backdate to 21 hours ago (between 20-24h)
        const old = new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE escrow_transactions SET locked_at = ? WHERE id = ?').run(old, esc.id);
        const warnings = helpers.getDispatchWarningEscrows();
        assert.ok(warnings.some(w => w.id === esc.id));
    });

    it('auto-expires escrow after 24h', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700600003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-sla2', '+256700600003');
        setupBuyer(helpers, '+256700600004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700600004', 300000);
        helpers.lockEscrow(esc.id, 'MOMO_SLA2');
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE escrow_transactions SET locked_at = ? WHERE id = ?').run(old, esc.id);
        const expired = helpers.getDispatchExpiredEscrows();
        assert.ok(expired.some(e => e.id === esc.id));
        const result = helpers.autoExpireEscrow(esc.id);
        assert.ok(result);
        assert.equal(result.status, 'CANCELLED');
    });
});

describe('Admin: disbursement with receipt ref', () => {
    it('disburses with valid receipt ref', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700700001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-dis1', '+256700700001');
        setupBuyer(helpers, '+256700700002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700700002', 1000000);
        helpers.lockEscrow(esc.id, 'MOMO_D1');
        helpers.dispatchEscrow(esc.id, '+256700700001', '0771111111', 'UAB 100Z');
        helpers.releaseEscrow(esc.id, '+256700700002');
        const result = helpers.disburseEscrow(esc.id, 'MTN-REF-12345');
        assert.ok(!result.error);
        assert.equal(result.payout_status, 'DISBURSED');
        assert.equal(result.disbursement_ref, 'MTN-REF-12345');
    });

    it('rejects disburse without receipt ref', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700700003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-dis2', '+256700700003');
        setupBuyer(helpers, '+256700700004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700700004', 500000);
        helpers.lockEscrow(esc.id, 'MOMO_D2');
        helpers.dispatchEscrow(esc.id, '+256700700003', '0772222222', 'UAB 200Z');
        helpers.releaseEscrow(esc.id, '+256700700004');
        const result = helpers.disburseEscrow(esc.id, '');
        assert.ok(result.error);
        assert.ok(result.error.includes('Disbursement reference'));
    });

    it('rejects double disburse', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700700005', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-dis3', '+256700700005');
        setupBuyer(helpers, '+256700700006', '5678');
        const esc = helpers.createEscrow(batchId, '+256700700006', 400000);
        helpers.lockEscrow(esc.id, 'MOMO_D3');
        helpers.dispatchEscrow(esc.id, '+256700700005', '0773333333', 'UAB 300Z');
        helpers.releaseEscrow(esc.id, '+256700700006');
        helpers.disburseEscrow(esc.id, 'MTN-REF-111');
        const result = helpers.disburseEscrow(esc.id, 'MTN-REF-222');
        assert.ok(result.error);
        assert.ok(result.error.includes('Already disbursed'));
    });
});

describe('Admin: stats and arbitration queue', () => {
    it('returns platform stats', () => {
        const { helpers } = makeApp();
        const stats = helpers.getAdminStats();
        assert.equal(typeof stats.total, 'number');
        assert.equal(typeof stats.total_revenue, 'number');
        assert.equal(typeof stats.pending_payout, 'number');
    });

    it('arbitration queue includes disputed escrows', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700800001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-arb1', '+256700800001');
        setupBuyer(helpers, '+256700800002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700800002', 600000);
        helpers.lockEscrow(esc.id, 'MOMO_A1');
        helpers.dispatchEscrow(esc.id, '+256700800001', '0774444444', 'UAB 400Z');
        helpers.disputeEscrow(esc.id, '+256700800002', 'Bad quality');
        const queue = helpers.getArbitrationQueue();
        const found = queue.find(q => q.id === esc.id);
        assert.ok(found);
        assert.equal(found.queue_type, 'DISPUTED');
        assert.ok(found.agent_trust);
    });

    it('delivery timeout escrows appear in arbitration queue', () => {
        const { helpers, db } = makeApp();
        setupAgent(helpers, '+256700800003', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-arb2', '+256700800003');
        setupBuyer(helpers, '+256700800004', '5678');
        const esc = helpers.createEscrow(batchId, '+256700800004', 400000);
        helpers.lockEscrow(esc.id, 'MOMO_A2');
        helpers.dispatchEscrow(esc.id, '+256700800003', '0775555555', 'UAB 500Z');
        // backdate dispatch to 73h ago
        const old = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE escrow_transactions SET dispatched_at = ? WHERE id = ?').run(old, esc.id);
        const queue = helpers.getArbitrationQueue();
        const found = queue.find(q => q.id === esc.id);
        assert.ok(found);
        assert.equal(found.queue_type, 'DELIVERY_TIMEOUT');
    });
});

describe('Admin: CSV export formatting', () => {
    it('strips + from phone and adds narration', async () => {
        const { app, helpers, db } = makeApp({ adminSecret: TEST_ADMIN_SECRET });
        setupAgent(helpers, '+256700900001', '1234', 'Mityana');
        const batchId = makeClosedBatch(helpers, db, 'b-csv1', '+256700900001');
        setupBuyer(helpers, '+256700900002', '5678');
        const esc = helpers.createEscrow(batchId, '+256700900002', 200000);
        helpers.lockEscrow(esc.id, 'MOMO_CSV');
        helpers.dispatchEscrow(esc.id, '+256700900001', '0776666666', 'UAB 600Z');
        helpers.releaseEscrow(esc.id, '+256700900002');
        const res = await req(app, 'get', '/api/admin/payout/export', null, { 'x-admin-secret': TEST_ADMIN_SECRET });
        assert.equal(res.status, 200);
        const csv = res.text;
        assert.ok(csv.includes('phone,amount,narration'));
        assert.ok(csv.includes('256700900001')); // no +
        assert.ok(!csv.includes('+256700900001'));
        assert.ok(csv.includes('AgriBridge Payout'));
    });
});

describe('Farmer listing dispatches leads to agents', () => {
    it('returns agents_notified count on farmer listing', async () => {
        const { app, helpers } = makeApp();
        helpers.saveProfile('+256700000060', 'Farmer X', 'Kibibi', 'Mityana');
        setupAgent(helpers, '+256700000070', '1234', 'Mityana');
        const res = await req(app, 'post', '/api/listings/farmer', {
            phone: '+256700000060', detail: 'Maize 100kg', asking_price: 1200, stock: '500kg'
        });
        assert.equal(res.status, 200);
        assert.ok(res.body.success);
        assert.equal(res.body.agents_notified, 1);
    });
});
