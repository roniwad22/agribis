#!/usr/bin/env node
/**
 * Agri-Bridge Seed Data — Realistic Uganda demo
 *
 * Usage:
 *   node scripts/seed.js              # seeds ./agribis.db (or DB_PATH)
 *   node scripts/seed.js --reset      # wipe + reseed
 *   SEED_DEMO=true node src/app.js    # auto-seeds on first boot
 *
 * Creates:
 *   - 6 farmers (profiles) across 4 districts
 *   - 3 agents (1 active, 1 pending, 1 suspended)
 *   - 2 buyers
 *   - Purchase ledger entries, batches, warehouse receipts
 *   - 1 complete escrow lifecycle (RELEASED)
 *   - 1 in-progress escrow (FUNDS_LOCKED — ready for dispatch demo)
 *   - 1 batch on marketplace (no escrow, available to buy)
 */

const path = require('path');
const crypto = require('crypto');

// Load the app's own modules so we use the same schema + helpers
const { createDb, createHelpers, seedPrices, hashPin } = require('../src/app');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'agribis.db');
const RESET = process.argv.includes('--reset');

function run() {
    if (RESET) {
        const fs = require('fs');
        [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm'].forEach(f => {
            try { fs.unlinkSync(f); } catch (_) {}
        });
        console.log('[SEED] Reset — deleted existing database');
    }

    const db = createDb(DB_PATH);
    seedPrices(db);
    const h = createHelpers(db);

    // Check if already seeded
    const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get().c;
    if (agentCount > 0 && !RESET) {
        console.log('[SEED] Database already has data. Use --reset to wipe and reseed.');
        db.close();
        return;
    }

    const now = new Date();
    const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
    const uid = () => crypto.randomUUID();

    // ──────────────────────────────────────────
    // FARMERS (profiles with PINs)
    // ──────────────────────────────────────────
    const farmers = [
        { phone: '+256701000001', name: 'Sarah Nakato',    parish: 'Bugolobi',    district: 'Kampala' },
        { phone: '+256701000002', name: 'James Okello',    parish: 'Lira Town',   district: 'Lira' },
        { phone: '+256701000003', name: 'Grace Namugga',   parish: 'Kawempe',     district: 'Kampala' },
        { phone: '+256701000004', name: 'Peter Odongo',    parish: 'Gulu Central',district: 'Gulu' },
        { phone: '+256701000005', name: 'Betty Auma',      parish: 'Soroti Town', district: 'Soroti' },
        { phone: '+256701000006', name: 'Moses Ssempijja', parish: 'Nakawa',      district: 'Kampala' },
    ];
    for (const f of farmers) {
        h.saveProfile(f.phone, f.name, f.parish, f.district, '1234');
    }
    console.log(`[SEED] ${farmers.length} farmers created`);

    // ──────────────────────────────────────────
    // AGENTS
    // ──────────────────────────────────────────
    const agents = [
        { phone: '+256770001001', name: 'David Mugisha',  pin: '5678', district: 'Kampala' },
        { phone: '+256770001002', name: 'Rose Atim',      pin: '5678', district: 'Lira' },
        { phone: '+256770001003', name: 'Henry Lubega',   pin: '5678', district: 'Gulu' },
    ];
    for (const a of agents) {
        h.registerAgent(a.phone, a.name, a.pin, a.district);
    }
    // Approve first agent, leave second pending, suspend third
    h.setAgentStatus(agents[0].phone, 'active');
    h.setAgentStatus(agents[1].phone, 'active');
    h.setAgentStatus(agents[2].phone, 'suspended');
    console.log('[SEED] 3 agents created (2 active, 1 suspended)');

    // ──────────────────────────────────────────
    // BUYERS
    // ──────────────────────────────────────────
    const buyers = [
        { phone: '+256780001001', name: 'Kampala Grain Traders', pin: '9999' },
        { phone: '+256780001002', name: 'Soroti Fresh Markets',  pin: '9999' },
    ];
    for (const b of buyers) {
        h.registerBuyer(b.phone, b.name, b.pin);
    }
    console.log(`[SEED] ${buyers.length} buyers created`);

    // ──────────────────────────────────────────
    // PURCHASES + BATCHES for Agent 1 (David — Kampala)
    // ──────────────────────────────────────────
    const agent1 = agents[0].phone;

    // Batch 1: Maize — completed lifecycle
    const purchases1 = [
        { farmer: farmers[0], crop: 'Maize', kg: 120, price: 1200, grade: 'A', moisture: 12.5, daysAgo: 10 },
        { farmer: farmers[2], crop: 'Maize', kg: 80,  price: 1100, grade: 'B', moisture: 13.0, daysAgo: 9 },
        { farmer: farmers[5], crop: 'Maize', kg: 150, price: 1250, grade: 'A', moisture: 12.0, daysAgo: 8 },
    ];
    const purchaseIds1 = [];
    for (const p of purchases1) {
        const id = uid();
        purchaseIds1.push(id);
        h.logPurchase({
            id,
            agent_phone: agent1,
            farmer_phone: p.farmer.phone,
            crop: p.crop,
            quantity_kg: p.kg,
            unit_price: p.price,
            total_price: p.kg * p.price,
            grade: p.grade,
            moisture_level: p.moisture,
            transaction_time: daysAgo(p.daysAgo),
            synced_at: daysAgo(p.daysAgo),
            lat: 0.3136 + Math.random() * 0.01,
            lng: 32.5811 + Math.random() * 0.01,
        });
    }

    const batch1Id = uid();
    h.createBatch({
        id: batch1Id,
        agent_phone: agent1,
        batch_code: 'KLA-MZ-001',
        crop: 'Maize',
        total_quantity_kg: 350,
        purchase_count: 3,
        avg_moisture: 12.5,
        overall_grade: 'A',
        created_at: daysAgo(8),
        purchase_ids: purchaseIds1,
    });
    h.closeBatch(batch1Id);

    // Warehouse receipt for batch 1
    h.lodgeBatch({
        id: uid(),
        batch_id: batch1Id,
        agent_phone: agent1,
        subcounty_location: 'Nakawa Industrial Area',
        facility_type: 'Rented Room',
        owner_name: 'Nakawa Storage Co.',
        photo_url: '/uploads/demo-warehouse.jpg',
        daily_storage_fee: 5000,
        date_lodged: daysAgo(7),
    });

    // Escrow for batch 1 — full lifecycle (RELEASED)
    const escrow1 = h.createEscrow(batch1Id, buyers[0].phone, 450000);
    h.lockEscrow(escrow1.id, 'MOMO_REF_DEMO_001');
    h.dispatchEscrow(escrow1.id, agent1);
    h.releaseEscrow(escrow1.id, buyers[0].phone);
    console.log('[SEED] Batch KLA-MZ-001: full escrow lifecycle (RELEASED)');

    // Batch 2: Beans — in escrow (FUNDS_LOCKED, ready for dispatch demo)
    const purchases2 = [
        { farmer: farmers[0], crop: 'Beans', kg: 60, price: 3500, grade: 'A', moisture: 11.0, daysAgo: 5 },
        { farmer: farmers[5], crop: 'Beans', kg: 40, price: 3400, grade: 'B', moisture: 11.5, daysAgo: 4 },
    ];
    const purchaseIds2 = [];
    for (const p of purchases2) {
        const id = uid();
        purchaseIds2.push(id);
        h.logPurchase({
            id,
            agent_phone: agent1,
            farmer_phone: p.farmer.phone,
            crop: p.crop,
            quantity_kg: p.kg,
            unit_price: p.price,
            total_price: p.kg * p.price,
            grade: p.grade,
            moisture_level: p.moisture,
            transaction_time: daysAgo(p.daysAgo),
            synced_at: daysAgo(p.daysAgo),
        });
    }

    const batch2Id = uid();
    h.createBatch({
        id: batch2Id,
        agent_phone: agent1,
        batch_code: 'KLA-BN-002',
        crop: 'Beans',
        total_quantity_kg: 100,
        purchase_count: 2,
        avg_moisture: 11.25,
        overall_grade: 'A',
        created_at: daysAgo(4),
        purchase_ids: purchaseIds2,
    });
    h.closeBatch(batch2Id);

    h.lodgeBatch({
        id: uid(),
        batch_id: batch2Id,
        agent_phone: agent1,
        subcounty_location: 'Kawempe Market Store',
        facility_type: 'Cooperative Store',
        owner_name: 'Kawempe Farmers Coop',
        photo_url: '/uploads/demo-warehouse-2.jpg',
        daily_storage_fee: 3000,
        date_lodged: daysAgo(3),
    });

    const escrow2 = h.createEscrow(batch2Id, buyers[0].phone, 350000);
    h.lockEscrow(escrow2.id, 'MOMO_REF_DEMO_002');
    console.log('[SEED] Batch KLA-BN-002: escrow FUNDS_LOCKED (ready for dispatch demo)');

    // ──────────────────────────────────────────
    // PURCHASES + BATCHES for Agent 2 (Rose — Lira)
    // ──────────────────────────────────────────
    const agent2 = agents[1].phone;

    // Batch 3: Rice — on marketplace (no escrow)
    const purchases3 = [
        { farmer: farmers[1], crop: 'Rice', kg: 200, price: 4500, grade: 'A', moisture: 13.0, daysAgo: 6 },
        { farmer: farmers[4], crop: 'Rice', kg: 100, price: 4200, grade: 'B', moisture: 13.5, daysAgo: 5 },
    ];
    const purchaseIds3 = [];
    for (const p of purchases3) {
        const id = uid();
        purchaseIds3.push(id);
        h.logPurchase({
            id,
            agent_phone: agent2,
            farmer_phone: p.farmer.phone,
            crop: p.crop,
            quantity_kg: p.kg,
            unit_price: p.price,
            total_price: p.kg * p.price,
            grade: p.grade,
            moisture_level: p.moisture,
            transaction_time: daysAgo(p.daysAgo),
            synced_at: daysAgo(p.daysAgo),
        });
    }

    const batch3Id = uid();
    h.createBatch({
        id: batch3Id,
        agent_phone: agent2,
        batch_code: 'LRA-RC-001',
        crop: 'Rice',
        total_quantity_kg: 300,
        purchase_count: 2,
        avg_moisture: 13.25,
        overall_grade: 'A',
        created_at: daysAgo(5),
        purchase_ids: purchaseIds3,
    });
    h.closeBatch(batch3Id);

    // Set sale price so marketplace shows it
    db.prepare('UPDATE batches SET sale_price = ? WHERE id = ?').run(1350000, batch3Id);

    h.lodgeBatch({
        id: uid(),
        batch_id: batch3Id,
        agent_phone: agent2,
        subcounty_location: 'Lira Central Market',
        facility_type: 'Rented Room',
        owner_name: 'Lira Produce Stores',
        photo_url: '/uploads/demo-warehouse-3.jpg',
        daily_storage_fee: 4000,
        date_lodged: daysAgo(4),
    });
    console.log('[SEED] Batch LRA-RC-001: on marketplace (available for purchase)');

    // Batch 4: Coffee — open batch (still collecting)
    const purchases4 = [
        { farmer: farmers[3], crop: 'Coffee', kg: 30, price: 8000, grade: 'A', moisture: 11.0, daysAgo: 2 },
    ];
    for (const p of purchases4) {
        h.logPurchase({
            id: uid(),
            agent_phone: agent2,
            farmer_phone: p.farmer.phone,
            crop: p.crop,
            quantity_kg: p.kg,
            unit_price: p.price,
            total_price: p.kg * p.price,
            grade: p.grade,
            moisture_level: p.moisture,
            transaction_time: daysAgo(p.daysAgo),
            synced_at: daysAgo(p.daysAgo),
        });
    }

    const batch4Id = uid();
    h.createBatch({
        id: batch4Id,
        agent_phone: agent2,
        batch_code: 'LRA-CF-002',
        crop: 'Coffee',
        total_quantity_kg: 30,
        purchase_count: 1,
        avg_moisture: 11.0,
        overall_grade: 'A',
        created_at: daysAgo(2),
        purchase_ids: [],  // manually linked above via logPurchase
    });
    console.log('[SEED] Batch LRA-CF-002: open (still collecting)');

    // ──────────────────────────────────────────
    // LISTINGS (farmer-posted)
    // ──────────────────────────────────────────
    const listings = [
        { phone: farmers[0].phone, detail: 'Fresh Maize, 200kg available', location: 'Bugolobi, Kampala', type: 'sell', asking_price: 240000, stock: '200 kg' },
        { phone: farmers[1].phone, detail: 'Rice paddy, 500kg ready for milling', location: 'Lira Town', type: 'sell', asking_price: 2250000, stock: '500 kg' },
        { phone: farmers[3].phone, detail: 'Robusta Coffee, sun-dried grade A', location: 'Gulu Central', type: 'sell', asking_price: 480000, stock: '60 kg' },
        { phone: buyers[1].phone, detail: 'Looking for 1 tonne of Maize, Kampala delivery', location: 'Kampala', type: 'buy', asking_price: 1200000, stock: '1000 kg' },
    ];
    for (const l of listings) {
        h.addListing({
            id: uid(),
            time: daysAgo(3),
            phone: l.phone,
            detail: l.detail,
            location: l.location,
            type: l.type,
            status: '[APPROVED]',
            asking_price: l.asking_price,
            price_unit: 'total',
            stock: l.stock,
        });
    }
    console.log(`[SEED] ${listings.length} listings created`);

    // ──────────────────────────────────────────
    // SUMMARY
    // ──────────────────────────────────────────
    console.log('\n[SEED] ✓ Demo data loaded successfully!');
    console.log('─'.repeat(40));
    console.log('Demo credentials (all PINs):');
    console.log('  Farmers:  +256701000001..006  PIN: 1234');
    console.log('  Agents:   +256770001001..003  PIN: 5678');
    console.log('  Buyers:   +256780001001..002  PIN: 9999');
    console.log('');
    console.log('  Agent 1 (David Mugisha) — active, 2 batches, 1 released escrow, 1 locked escrow');
    console.log('  Agent 2 (Rose Atim) — active, 2 batches, 1 on marketplace, 1 open');
    console.log('  Agent 3 (Henry Lubega) — suspended, no batches');
    console.log('─'.repeat(40));

    db.close();
}

run();
