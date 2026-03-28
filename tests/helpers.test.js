const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createDb, createHelpers, seedPrices, hashPin } = require('../src/app');

describe('Database helpers', () => {
    let db, helpers;

    beforeEach(() => {
        db = createDb(':memory:');
        helpers = createHelpers(db);
    });

    describe('getProfile / saveProfile', () => {
        it('returns null for unknown phone', () => {
            assert.equal(helpers.getProfile('+256700000000'), null);
        });

        it('saves and retrieves a profile', () => {
            helpers.saveProfile('+256700000000', 'Kato', 'Kibibi', 'Mityana');
            const p = helpers.getProfile('+256700000000');
            assert.equal(p.name, 'Kato');
            assert.equal(p.parish, 'Kibibi');
            assert.equal(p.district, 'Mityana');
        });

        it('upserts existing profile', () => {
            helpers.saveProfile('+256700000000', 'Kato', 'Kibibi', 'Mityana');
            helpers.saveProfile('+256700000000', 'Nakato', 'Bombo', 'Luwero');
            const p = helpers.getProfile('+256700000000');
            assert.equal(p.name, 'Nakato');
            assert.equal(p.parish, 'Bombo');
        });
    });

    describe('addListing / getApprovedListings / getAllListings', () => {
        it('adds a listing and retrieves it', () => {
            helpers.addListing({ id: '1', time: 'now', phone: '+256700000000', detail: 'Maize 50kg', location: 'Kibibi', type: 'VILLAGE', status: '[APPROVED]' });
            const all = helpers.getAllListings();
            assert.equal(all.length, 1);
            assert.equal(all[0].detail, 'Maize 50kg');
        });

        it('getApprovedListings filters by type and status', () => {
            helpers.addListing({ id: '1', time: 'now', phone: '+1', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
            helpers.addListing({ id: '2', time: 'now', phone: '+2', detail: 'Beans', location: 'B', type: 'VILLAGE', status: '[PENDING]' });
            helpers.addListing({ id: '3', time: 'now', phone: '+3', detail: 'Rice', location: 'C', type: 'CITY', status: '[APPROVED]' });

            const village = helpers.getApprovedListings('VILLAGE');
            assert.equal(village.length, 1);
            assert.equal(village[0].detail, 'Maize');

            const city = helpers.getApprovedListings('CITY');
            assert.equal(city.length, 1);
            assert.equal(city[0].detail, 'Rice');
        });

        it('getApprovedListings returns max 20', () => {
            for (let i = 0; i < 25; i++) {
                helpers.addListing({ id: String(i), time: 'now', phone: `+${i}`, detail: `Item ${i}`, location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
            }
            const result = helpers.getApprovedListings('VILLAGE');
            assert.equal(result.length, 20);
        });
    });

    describe('updateListingStatus', () => {
        it('changes status from PENDING to APPROVED', () => {
            helpers.addListing({ id: 'x1', time: 'now', phone: '+1', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[PENDING]' });
            helpers.updateListingStatus('x1', '[APPROVED]');
            const all = helpers.getAllListings();
            assert.equal(all[0].status, '[APPROVED]');
        });
    });

    describe('getPrices / setPrices', () => {
        it('returns empty array when no prices', () => {
            const prices = helpers.getPrices();
            assert.deepEqual(prices, []);
        });

        it('sets and gets prices with units', () => {
            helpers.setPrices({ Maize: '1200', Beans: '3500' });
            const prices = helpers.getPrices();
            const maize = prices.find(p => p.crop === 'Maize');
            const beans = prices.find(p => p.crop === 'Beans');
            assert.equal(maize.price, '1200');
            assert.equal(maize.unit, 'per kg');
            assert.equal(beans.price, '3500');
        });

        it('upserts existing prices', () => {
            helpers.setPrices({ Maize: '1200' });
            helpers.setPrices({ Maize: '1500' });
            const prices = helpers.getPrices();
            const maize = prices.find(p => p.crop === 'Maize');
            assert.equal(maize.price, '1500');
        });
    });

    describe('getListing', () => {
        it('returns listing by id', () => {
            helpers.addListing({ id: 'abc', time: 'now', phone: '+1', detail: 'Rice 10kg', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
            const l = helpers.getListing('abc');
            assert.equal(l.id, 'abc');
            assert.equal(l.detail, 'Rice 10kg');
        });

        it('returns null for unknown id', () => {
            assert.equal(helpers.getListing('nonexistent'), null);
        });
    });

    describe('setListingVideo', () => {
        it('sets video filename on a listing', () => {
            helpers.addListing({ id: 'vid1', time: 'now', phone: '+1', detail: 'Maize', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
            helpers.setListingVideo('vid1', 'clip-123.mp4');
            const l = helpers.getListing('vid1');
            assert.equal(l.video, 'clip-123.mp4');
        });

        it('video is null by default', () => {
            helpers.addListing({ id: 'vid2', time: 'now', phone: '+1', detail: 'Beans', location: 'B', type: 'CITY', status: '[APPROVED]' });
            const l = helpers.getListing('vid2');
            assert.equal(l.video, null);
        });
    });

    describe('seedPrices', () => {
        it('seeds default prices with units when table is empty', () => {
            seedPrices(db);
            const prices = helpers.getPrices();
            const maize = prices.find(p => p.crop === 'Maize');
            const beans = prices.find(p => p.crop === 'Beans');
            const matooke = prices.find(p => p.crop === 'Matooke');
            assert.equal(maize.price, '1200');
            assert.equal(maize.unit, 'per kg');
            assert.equal(beans.price, '3500');
            assert.equal(matooke.price, '25000');
            assert.equal(matooke.unit, 'per bunch');
        });

        it('does not overwrite existing prices', () => {
            helpers.setPrices({ Maize: '9999' });
            seedPrices(db);
            const prices = helpers.getPrices();
            const maize = prices.find(p => p.crop === 'Maize');
            assert.equal(maize.price, '9999');
        });
    });

    // ==========================================
    // AGENT REGISTRATION & AUTH
    // ==========================================
    describe('registerAgent / authenticateAgent', () => {
        it('registers agent with pending status', () => {
            const result = helpers.registerAgent('+256700000090', 'Agent Bob', '5555', 'Mityana');
            assert.ok(result.success);
            assert.equal(result.status, 'pending');
            const agent = helpers.getAgent('+256700000090');
            assert.equal(agent.name, 'Agent Bob');
            assert.equal(agent.status, 'pending');
            assert.equal(agent.district, 'Mityana');
        });

        it('rejects duplicate agent phone', () => {
            helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
            const result = helpers.registerAgent('+256700000090', 'Bob2', '6666', 'Kampala');
            assert.ok(result.error);
            assert.match(result.error, /already registered/i);
        });

        it('authenticates active agent with correct PIN', () => {
            helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
            helpers.setAgentStatus('+256700000090', 'active');
            const result = helpers.authenticateAgent('+256700000090', '5555');
            assert.ok(result.agent);
            assert.equal(result.agent.name, 'Bob');
        });

        it('rejects wrong PIN', () => {
            helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
            helpers.setAgentStatus('+256700000090', 'active');
            const result = helpers.authenticateAgent('+256700000090', '9999');
            assert.ok(result.error);
            assert.match(result.error, /invalid credentials/i);
        });

        it('rejects pending agent', () => {
            helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
            const result = helpers.authenticateAgent('+256700000090', '5555');
            assert.ok(result.error);
            assert.match(result.error, /pending/i);
        });

        it('rejects suspended agent', () => {
            helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
            helpers.setAgentStatus('+256700000090', 'suspended');
            const result = helpers.authenticateAgent('+256700000090', '5555');
            assert.ok(result.error);
            assert.match(result.error, /suspended/i);
        });

        it('rejects unknown phone', () => {
            const result = helpers.authenticateAgent('+256700000000', '5555');
            assert.ok(result.error);
        });
    });

    describe('setAgentStatus / getAllAgents', () => {
        it('changes agent status', () => {
            helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
            helpers.setAgentStatus('+256700000090', 'active');
            assert.equal(helpers.getAgent('+256700000090').status, 'active');
        });

        it('getAllAgents returns all agents', () => {
            helpers.registerAgent('+256700000091', 'A1', '1111', 'X');
            helpers.registerAgent('+256700000092', 'A2', '2222', 'Y');
            const all = helpers.getAllAgents();
            assert.equal(all.length, 2);
        });
    });

    describe('isAgentSuspended (with agents table)', () => {
        it('returns true when agent status is suspended', () => {
            helpers.registerAgent('+256700000090', 'Bob', '5555', 'Mityana');
            helpers.setAgentStatus('+256700000090', 'suspended');
            assert.ok(helpers.isAgentSuspended('+256700000090'));
        });

        it('returns true with 3+ strikes even if not in agents table', () => {
            // Legacy behavior: strikes-based suspension without agents table entry
            const now = new Date().toISOString();
            for (let i = 0; i < 3; i++) {
                helpers.addListing({ id: `sus${i}`, time: now, phone: '+256700000010', detail: 'X', location: 'A', type: 'VILLAGE', status: '[APPROVED]' });
                helpers.setVerification(`sus${i}`, { agent_phone: '+256700000060' });
                helpers.addFeedback(`sus${i}`, '+256700000010', `+25670000007${i}`, 1, 'Bad');
            }
            assert.ok(helpers.isAgentSuspended('+256700000060'));
        });
    });

    // ==========================================
    // BUYER REGISTRATION & AUTH
    // ==========================================
    describe('registerBuyer / authenticateBuyer', () => {
        it('registers buyer successfully', () => {
            const result = helpers.registerBuyer('+256700000080', 'Buyer Jane', '1234');
            assert.ok(result.success);
            const buyer = helpers.getBuyer('+256700000080');
            assert.equal(buyer.name, 'Buyer Jane');
        });

        it('rejects duplicate buyer phone', () => {
            helpers.registerBuyer('+256700000080', 'Jane', '1234');
            const result = helpers.registerBuyer('+256700000080', 'Jane2', '5678');
            assert.ok(result.error);
            assert.match(result.error, /already registered/i);
        });

        it('authenticates with correct PIN', () => {
            helpers.registerBuyer('+256700000080', 'Jane', '1234');
            const buyer = helpers.authenticateBuyer('+256700000080', '1234');
            assert.ok(buyer);
            assert.equal(buyer.name, 'Jane');
        });

        it('returns null for wrong PIN', () => {
            helpers.registerBuyer('+256700000080', 'Jane', '1234');
            const buyer = helpers.authenticateBuyer('+256700000080', '0000');
            assert.equal(buyer, null);
        });

        it('returns null for unknown phone', () => {
            const buyer = helpers.authenticateBuyer('+256700000000', '1234');
            assert.equal(buyer, null);
        });
    });

    // ==========================================
    // hashPin utility
    // ==========================================
    describe('hashPin', () => {
        it('returns consistent hash for same input', () => {
            assert.equal(hashPin('1234'), hashPin('1234'));
        });

        it('returns different hash for different input', () => {
            assert.notEqual(hashPin('1234'), hashPin('5678'));
        });

        it('returns 64-char hex string', () => {
            const hash = hashPin('1234');
            assert.equal(hash.length, 64);
            assert.match(hash, /^[0-9a-f]{64}$/);
        });
    });
});
