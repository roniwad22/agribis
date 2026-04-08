require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const { createApiRouter } = require('./api');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const escapeHtml = require('escape-html');

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// ==========================================
// DISCORD WEBHOOK NOTIFIER (fire-and-forget)
// ==========================================
function createNotifier(webhookUrl) {
    if (!webhookUrl) return { send: () => {}, error: () => {}, event: () => {} };
    const post = (payload) => {
        try {
            const url = new URL(webhookUrl);
            const data = JSON.stringify(payload);
            const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
            const lib = url.protocol === 'https:' ? require('https') : require('http');
            const req = lib.request(url, options);
            req.on('error', () => {}); // fire-and-forget
            req.write(data);
            req.end();
        } catch (_) {}
    };
    return {
        send(msg) { post({ content: msg }); },
        error(context, err) {
            post({ embeds: [{ title: 'Error', color: 0xc62828, description: `**${context}**\n\`\`\`${String(err).slice(0, 500)}\`\`\``, timestamp: new Date().toISOString() }] });
        },
        event(title, fields) {
            post({ embeds: [{ title, color: 0x1565c0, fields: Object.entries(fields).map(([k, v]) => ({ name: k, value: String(v), inline: true })), timestamp: new Date().toISOString() }] });
        }
    };
}

function parseCookies(req) {
    const list = {};
    const header = req.headers.cookie;
    if (!header) return list;
    header.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name.trim();
        if (name) list[name] = decodeURIComponent(rest.join('=').trim());
    });
    return list;
}

function generateCsrfToken() {
    return crypto.randomBytes(32).toString('hex');
}

function validateCsrf(req) {
    const cookieToken = parseCookies(req)['csrf_token'];
    const bodyToken = req.body && req.body._csrf;
    return !!(cookieToken && bodyToken && crypto.timingSafeEqual(
        Buffer.from(cookieToken), Buffer.from(bodyToken)
    ));
}

// ==========================================
// SMS HELPER
// ==========================================
function createSms() {
    try {
        const apiKey = process.env.AT_API_KEY;
        const username = process.env.AT_USERNAME;
        if (!apiKey || !username) return null;
        const AT = require('africastalking')({ apiKey, username });
        return AT.SMS;
    } catch (e) {
        console.error('[SMS] Failed to initialise AT SDK:', e.message);
        return null;
    }
}

async function sendSms(sms, to, message) {
    if (!sms) return; // SMS not configured — skip silently
    try {
        await sms.send({ to: [to], message });
    } catch (e) {
        console.error(`[SMS] Failed to send to ${to}:`, e.message);
    }
}

// ==========================================
// DATABASE SETUP
// ==========================================
function createDb(dbPath) {
    const db = new Database(dbPath);
    // Migrate existing DB: add missing columns
    try { db.exec('ALTER TABLE listings ADD COLUMN video TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE prices ADD COLUMN unit TEXT DEFAULT \'per kg\''); } catch (_) {}
    try { db.exec('ALTER TABLE listings ADD COLUMN verification TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE profiles ADD COLUMN pin_hash TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE listings ADD COLUMN asking_price INTEGER'); } catch (_) {}
    try { db.exec('ALTER TABLE listings ADD COLUMN price_unit TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE listings ADD COLUMN stock TEXT'); } catch (_) {}
    try { db.exec('ALTER TABLE listings ADD COLUMN lat REAL'); } catch (_) {}
    try { db.exec('ALTER TABLE listings ADD COLUMN lng REAL'); } catch (_) {}
    // Fix units for crops that aren't sold per kg
    try { db.exec("UPDATE prices SET unit = 'per bunch' WHERE crop = 'Matooke' AND unit = 'per kg'"); } catch (_) {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        time TEXT,
        phone TEXT,
        detail TEXT,
        location TEXT,
        type TEXT,
        status TEXT,
        video TEXT,
        verification TEXT,
        asking_price INTEGER,
        price_unit TEXT,
        stock TEXT,
        lat REAL,
        lng REAL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        phone TEXT PRIMARY KEY,
        name TEXT,
        parish TEXT,
        district TEXT,
        pin_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS prices (
        crop TEXT PRIMARY KEY,
        price TEXT,
        unit TEXT DEFAULT 'per kg'
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        listing_id TEXT,
        farmer_phone TEXT,
        buyer_phone TEXT,
        rating INTEGER,
        comment TEXT,
        time TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_strikes (
        id TEXT PRIMARY KEY,
        agent_phone TEXT,
        listing_id TEXT,
        farmer_phone TEXT,
        reason TEXT,
        time TEXT
      );
      CREATE TABLE IF NOT EXISTS agents (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        district TEXT,
        status TEXT DEFAULT 'pending',
        registered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS buyers (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        registered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS otp_codes (
        phone TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        purpose TEXT NOT NULL,
        payload TEXT,
        expires_at INTEGER NOT NULL,
        attempts INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS commissions (
        id TEXT PRIMARY KEY,
        agent_phone TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 5000,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS purchase_ledger (
        id TEXT PRIMARY KEY,
        agent_phone TEXT NOT NULL,
        farmer_phone TEXT NOT NULL,
        listing_id TEXT,
        crop TEXT NOT NULL,
        quantity_kg REAL NOT NULL,
        unit_price INTEGER NOT NULL,
        total_price INTEGER NOT NULL,
        price_unit TEXT DEFAULT 'per kg',
        grade TEXT,
        moisture_level REAL,
        transaction_time TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        lat REAL,
        lng REAL,
        notes TEXT,
        batch_id TEXT,
        FOREIGN KEY (agent_phone) REFERENCES agents(phone),
        FOREIGN KEY (farmer_phone) REFERENCES profiles(phone)
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        agent_phone TEXT NOT NULL,
        batch_code TEXT NOT NULL UNIQUE,
        crop TEXT NOT NULL,
        total_quantity_kg REAL NOT NULL DEFAULT 0,
        purchase_count INTEGER NOT NULL DEFAULT 0,
        avg_moisture REAL,
        overall_grade TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT NOT NULL,
        closed_at TEXT,
        sale_price INTEGER,
        buyer_phone TEXT,
        sold_at TEXT,
        FOREIGN KEY (agent_phone) REFERENCES agents(phone)
      );
      CREATE TABLE IF NOT EXISTS warehouse_receipts (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE,
        agent_phone TEXT NOT NULL,
        subcounty_location TEXT NOT NULL,
        facility_type TEXT NOT NULL DEFAULT 'Rented Room',
        owner_name TEXT,
        photo_url TEXT NOT NULL,
        daily_storage_fee INTEGER NOT NULL DEFAULT 0,
        date_lodged TEXT NOT NULL,
        date_withdrawn TEXT,
        notes TEXT,
        FOREIGN KEY (batch_id) REFERENCES batches(id),
        FOREIGN KEY (agent_phone) REFERENCES agents(phone)
      );
      CREATE TABLE IF NOT EXISTS escrow_transactions (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE,
        agent_phone TEXT NOT NULL,
        buyer_phone TEXT NOT NULL,
        total_amount INTEGER NOT NULL,
        platform_fee INTEGER NOT NULL,
        agent_payout INTEGER NOT NULL,
        status TEXT DEFAULT 'PENDING_PAYMENT',
        payout_status TEXT DEFAULT 'PENDING',
        momo_reference TEXT,
        created_at TEXT NOT NULL,
        locked_at TEXT,
        dispatched_at TEXT,
        released_at TEXT,
        cancelled_at TEXT,
        notes TEXT,
        driver_phone TEXT,
        truck_plate_number TEXT,
        disbursed_at TEXT,
        disbursement_ref TEXT,
        FOREIGN KEY (batch_id) REFERENCES batches(id),
        FOREIGN KEY (agent_phone) REFERENCES agents(phone)
      );
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        method TEXT,
        path TEXT,
        phone TEXT,
        status_code INTEGER,
        duration_ms INTEGER,
        error TEXT,
        type TEXT DEFAULT 'API'
      );
    `);
    return db;
}

function seedPrices(db) {
    const priceCount = db.prepare('SELECT COUNT(*) as c FROM prices').get();
    if (priceCount.c === 0) {
        const insert = db.prepare('INSERT INTO prices (crop,price,unit) VALUES (?,?,?)');
        db.transaction(() => {
            insert.run('Maize', '1200', 'per kg');
            insert.run('Beans', '3500', 'per kg');
            insert.run('Matooke', '25000', 'per bunch');
            insert.run('Rice', '4500', 'per kg');
            insert.run('Cassava', '1500', 'per kg');
            insert.run('Coffee', '8000', 'per kg');
            insert.run('G-Nuts', '6000', 'per kg');
            insert.run('Millet', '3000', 'per kg');
            insert.run('Sorghum', '2500', 'per kg');
            insert.run('Sweet Potatoes', '1000', 'per kg');
            insert.run('Irish Potatoes', '2000', 'per kg');
            insert.run('Soya Beans', '3500', 'per kg');
            insert.run('Sesame (Simsim)', '7000', 'per kg');
            insert.run('Tomatoes', '3000', 'per kg');
            insert.run('Onions', '4000', 'per kg');
            insert.run('Cabbage', '2000', 'per head');
            insert.run('Pineapple', '3000', 'per piece');
            insert.run('Sugarcane', '500', 'per stick');
        })();
    }
}

// Migrate existing JSON data on first run
function migrateJSON(db, file, migrateFunc) {
    if (!fs.existsSync(file)) return;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        migrateFunc(db, data);
        fs.renameSync(file, file + '.migrated');
        console.log(`Migrated ${file} to SQLite`);
    } catch (e) {
        console.log(`Migration skipped for ${file}: ${e.message}`);
    }
}

// ==========================================
// DB HELPER FUNCTIONS
// ==========================================
function createHelpers(db) {
    const helpers = {
        getProfile(phone) {
            return db.prepare('SELECT * FROM profiles WHERE phone = ?').get(phone) || null;
        },
        saveProfile(phone, name, parish, district, pin) {
            const pinHash = pin ? hashPin(pin) : null;
            db.prepare('INSERT OR REPLACE INTO profiles (phone,name,parish,district,pin_hash) VALUES (?,?,?,?,COALESCE(?,( SELECT pin_hash FROM profiles WHERE phone = ?)))').run(phone, name, parish, district, pinHash, phone);
        },
        setProfilePin(phone, pin) {
            db.prepare('UPDATE profiles SET pin_hash = ? WHERE phone = ?').run(hashPin(pin), phone);
        },
        authenticateProfile(phone, pin) {
            const profile = db.prepare('SELECT * FROM profiles WHERE phone = ?').get(phone);
            if (!profile) return null;
            if (!profile.pin_hash) return null; // no PIN set yet
            if (profile.pin_hash !== hashPin(pin)) return null;
            return profile;
        },
        addListing(listing) {
            db.prepare('INSERT INTO listings (id,time,phone,detail,location,type,status,asking_price,price_unit,stock,lat,lng) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(listing.id, listing.time, listing.phone, listing.detail, listing.location, listing.type, listing.status,
                   listing.asking_price || null, listing.price_unit || null, listing.stock || null,
                   listing.lat || null, listing.lng || null);
        },
        getApprovedListings(type, crop) {
            if (crop) {
                return db.prepare("SELECT * FROM listings WHERE type = ? AND status = '[APPROVED]' AND LOWER(detail) LIKE ? ORDER BY rowid DESC LIMIT 20").all(type, '%' + crop.toLowerCase() + '%');
            }
            return db.prepare("SELECT * FROM listings WHERE type = ? AND status = '[APPROVED]' ORDER BY rowid DESC LIMIT 20").all(type);
        },
        getListing(id) {
            return db.prepare('SELECT * FROM listings WHERE id = ?').get(id) || null;
        },
        getAllListings() {
            return db.prepare('SELECT * FROM listings ORDER BY rowid DESC').all();
        },
        updateListingStatus(id, status) {
            db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(status, id);
        },
        setListingVideo(id, filename) {
            db.prepare('UPDATE listings SET video = ? WHERE id = ?').run(filename, id);
        },
        setVerification(id, data) {
            db.prepare('UPDATE listings SET verification = ? WHERE id = ?').run(JSON.stringify(data), id);
        },
        getVerification(id) {
            const row = db.prepare('SELECT verification FROM listings WHERE id = ?').get(id);
            if (!row || !row.verification) return null;
            try { return JSON.parse(row.verification); } catch (_) { return null; }
        },
        hasFeedback(listingId, buyerPhone) {
            const row = db.prepare('SELECT COUNT(*) as c FROM feedback WHERE listing_id = ? AND buyer_phone = ?').get(listingId, buyerPhone);
            return row.c > 0;
        },
        getRecentListings(farmerPhone, limit) {
            return db.prepare("SELECT * FROM listings WHERE phone = ? AND status = '[APPROVED]' ORDER BY rowid DESC LIMIT ?").all(farmerPhone, limit || 3);
        },
        addFeedback(listingId, farmerPhone, buyerPhone, rating, comment) {
            // Guard: listing_id required
            if (!listingId) return { error: 'listing_id required' };
            // Guard: listing must exist
            const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
            if (!listing) return { error: 'Listing not found' };
            // Guard: 7-day window
            const listingDate = new Date(listing.time);
            const now = new Date();
            const daysDiff = (now - listingDate) / (1000 * 60 * 60 * 24);
            if (daysDiff > 7) return { error: 'Rating window closed (7 days)' };
            // Guard: one rating per buyer per listing
            if (helpers.hasFeedback(listingId, buyerPhone)) return { error: 'Already rated this listing' };

            db.prepare('INSERT INTO feedback (id,listing_id,farmer_phone,buyer_phone,rating,comment,time) VALUES (?,?,?,?,?,?,?)')
              .run(crypto.randomUUID(), listingId, farmerPhone, buyerPhone, rating, comment || '', new Date().toISOString());
            // Cascading accountability: if rating is 1-2, strike the verifying agent
            if (rating <= 2) {
                if (listing.verification) {
                    try {
                        const v = JSON.parse(listing.verification);
                        if (v.agent_phone) {
                            db.prepare('INSERT INTO agent_strikes (id,agent_phone,listing_id,farmer_phone,reason,time) VALUES (?,?,?,?,?,?)')
                              .run(crypto.randomUUID(), v.agent_phone, listingId, farmerPhone, `Bad rating (${rating}/5) from buyer`, new Date().toISOString());
                        }
                    } catch (_) {}
                }
            }
            return { success: true };
        },
        getAgentRecord(agentPhone) {
            const strikes = db.prepare('SELECT * FROM agent_strikes WHERE agent_phone = ? ORDER BY rowid DESC').all(agentPhone);
            const verifications = db.prepare("SELECT COUNT(*) as c FROM listings WHERE verification LIKE ?").get(`%${agentPhone}%`);
            const suspended = strikes.length >= 3;
            const commissionRows = db.prepare('SELECT SUM(amount) as total, COUNT(*) as count FROM commissions WHERE agent_phone = ?').get(agentPhone);
            return {
                phone: agentPhone,
                strikes: strikes.length,
                verifications: verifications.c,
                suspended,
                details: strikes.slice(0, 5),
                commissions_count: commissionRows.count || 0,
                commissions_total: commissionRows.total || 0
            };
        },
        addCommission(agentPhone, listingId, amount) {
            db.prepare('INSERT INTO commissions (id,agent_phone,listing_id,amount,status,created_at) VALUES (?,?,?,?,?,?)')
              .run(crypto.randomUUID(), agentPhone, listingId, amount || 5000, 'pending', new Date().toISOString());
        },
        getAgentCommissions(agentPhone) {
            return db.prepare('SELECT * FROM commissions WHERE agent_phone = ? ORDER BY rowid DESC LIMIT 50').all(agentPhone);
        },
        isAgentSuspended(agentPhone) {
            const agent = db.prepare('SELECT status FROM agents WHERE phone = ?').get(agentPhone);
            if (agent && agent.status === 'suspended') return true;
            const count = db.prepare('SELECT COUNT(*) as c FROM agent_strikes WHERE agent_phone = ?').get(agentPhone);
            return count.c >= 3;
        },
        // --- Agent registration & auth ---
        registerAgent(phone, name, pin, district) {
            const existing = db.prepare('SELECT phone FROM agents WHERE phone = ?').get(phone);
            if (existing) return { error: 'Phone already registered as agent' };
            db.prepare('INSERT INTO agents (phone,name,pin_hash,district,status,registered_at) VALUES (?,?,?,?,?,?)')
              .run(phone, name, hashPin(pin), district || null, 'pending', new Date().toISOString());
            return { success: true, status: 'pending' };
        },
        authenticateAgent(phone, pin) {
            const agent = db.prepare('SELECT * FROM agents WHERE phone = ?').get(phone);
            if (!agent) return { error: 'Invalid credentials' };
            if (agent.pin_hash !== hashPin(pin)) return { error: 'Invalid credentials' };
            if (agent.status === 'pending') return { error: 'Pending admin approval' };
            if (agent.status === 'suspended') return { error: 'Account suspended' };
            return { agent };
        },
        getAgent(phone) {
            return db.prepare('SELECT * FROM agents WHERE phone = ?').get(phone) || null;
        },
        setAgentStatus(phone, status) {
            db.prepare('UPDATE agents SET status = ? WHERE phone = ?').run(status, phone);
        },
        getAllAgents() {
            return db.prepare('SELECT * FROM agents ORDER BY rowid DESC').all();
        },
        // --- Buyer registration & auth ---
        registerBuyer(phone, name, pin) {
            const existing = db.prepare('SELECT phone FROM buyers WHERE phone = ?').get(phone);
            if (existing) return { error: 'Phone already registered' };
            db.prepare('INSERT INTO buyers (phone,name,pin_hash,registered_at) VALUES (?,?,?,?)')
              .run(phone, name, hashPin(pin), new Date().toISOString());
            return { success: true };
        },
        authenticateBuyer(phone, pin) {
            const buyer = db.prepare('SELECT * FROM buyers WHERE phone = ?').get(phone);
            if (!buyer) return null;
            if (buyer.pin_hash !== hashPin(pin)) return null;
            return buyer;
        },
        getBuyer(phone) {
            return db.prepare('SELECT * FROM buyers WHERE phone = ?').get(phone) || null;
        },
        // --- OTP ---
        generateOtp() {
            return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
        },
        storeOtp(phone, code, purpose, payload) {
            const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
            db.prepare('INSERT OR REPLACE INTO otp_codes (phone,code,purpose,payload,expires_at,attempts) VALUES (?,?,?,?,?,0)')
              .run(phone, code, purpose, payload ? JSON.stringify(payload) : null, expiresAt);
        },
        verifyOtp(phone, code, purpose) {
            const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ? AND purpose = ?').get(phone, purpose);
            if (!row) return { error: 'No OTP requested. Start registration again.' };
            if (row.attempts >= 3) {
                db.prepare('DELETE FROM otp_codes WHERE phone = ? AND purpose = ?').run(phone, purpose);
                return { error: 'Too many attempts. Request a new code.' };
            }
            db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ? AND purpose = ?').run(phone, purpose);
            if (Date.now() > row.expires_at) {
                db.prepare('DELETE FROM otp_codes WHERE phone = ? AND purpose = ?').run(phone, purpose);
                return { error: 'Code expired. Request a new one.' };
            }
            if (row.code !== code) return { error: 'Invalid code' };
            db.prepare('DELETE FROM otp_codes WHERE phone = ? AND purpose = ?').run(phone, purpose);
            return { success: true, payload: row.payload ? JSON.parse(row.payload) : null };
        },
        getStoredOtp(phone, purpose) {
            const row = db.prepare('SELECT code FROM otp_codes WHERE phone = ? AND purpose = ?').get(phone, purpose);
            return row ? row.code : null;
        },
        cleanExpiredOtps() {
            db.prepare('DELETE FROM otp_codes WHERE expires_at < ?').run(Date.now());
        },
        getFarmerReputation(phone) {
            const reviews = db.prepare('SELECT rating FROM feedback WHERE farmer_phone = ?').all(phone);
            if (!reviews.length) return { tier: 'NEW', sales: 0, avg: 0 };
            const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
            const sales = reviews.length;
            let tier = 'NEW';
            if (sales >= 5 && avg >= 4) tier = 'TRUSTED';
            else if (sales >= 1) tier = 'ACTIVE';
            return { tier, sales, avg: Math.round(avg * 10) / 10 };
        },
        getFarmerTrustLabel(phone) {
            const v = db.prepare("SELECT COUNT(*) as c FROM listings WHERE phone = ? AND verification IS NOT NULL").get(phone);
            const rep = helpers.getFarmerReputation(phone);
            const profile = helpers.getProfile(phone);
            const verified = v.c > 0;
            if (rep.tier === 'TRUSTED') return `[TRUSTED ${rep.avg}/5 ${rep.sales} sales]`;
            if (verified && rep.tier === 'ACTIVE') return `[VERIFIED ${rep.avg}/5 ${rep.sales} sales]`;
            if (verified) return '[VERIFIED]';
            if (rep.tier === 'ACTIVE') return `[${rep.sales} sales]`;
            // New seller — show identity if registered, warning if not
            if (profile) return `[Registered · ${profile.parish}, ${profile.district}]`;
            return '[UNREGISTERED]';
        },
        getPrices() {
            const rows = db.prepare('SELECT crop, price, unit FROM prices').all();
            return rows.map(r => ({ crop: r.crop, price: r.price, unit: r.unit || 'per kg' }));
        },
        getPricesMap() {
            const rows = db.prepare('SELECT crop, price, unit FROM prices').all();
            return Object.fromEntries(rows.map(r => [r.crop, r.price]));
        },
        setPrices(pricesObj) {
            const upsert = db.prepare('INSERT OR REPLACE INTO prices (crop,price,unit) VALUES (?,?,?)');
            db.transaction(() => {
                for (const [crop, val] of Object.entries(pricesObj)) {
                    if (typeof val === 'object' && val.price) {
                        upsert.run(crop, val.price, val.unit || 'per kg');
                    } else {
                        // Backward compat: plain { crop: price } from dashboard form
                        const existing = db.prepare('SELECT unit FROM prices WHERE crop = ?').get(crop);
                        upsert.run(crop, val, existing?.unit || 'per kg');
                    }
                }
            })();
        },
        getPriceRanges() {
            return db.prepare(`
                SELECT LOWER(SUBSTR(detail, 1, INSTR(detail || ' ', ' ') - 1)) as crop, type,
                       MIN(asking_price) as min_price, MAX(asking_price) as max_price,
                       COUNT(*) as count
                FROM listings
                WHERE status = '[APPROVED]' AND asking_price IS NOT NULL AND asking_price > 0
                GROUP BY crop, type
            `).all();
        },
        // --- Purchase Ledger ---
        logPurchase(purchase) {
            db.prepare(`INSERT INTO purchase_ledger
                (id, agent_phone, farmer_phone, listing_id, crop, quantity_kg, unit_price, total_price, price_unit, grade, moisture_level, transaction_time, synced_at, lat, lng, notes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(purchase.id, purchase.agent_phone, purchase.farmer_phone, purchase.listing_id || null,
                   purchase.crop, purchase.quantity_kg, purchase.unit_price, purchase.total_price,
                   purchase.price_unit || 'per kg', purchase.grade || null, purchase.moisture_level || null,
                   purchase.transaction_time, purchase.synced_at,
                   purchase.lat || null, purchase.lng || null, purchase.notes || null);
        },
        getAgentPurchases(agentPhone) {
            return db.prepare('SELECT * FROM purchase_ledger WHERE agent_phone = ? ORDER BY synced_at DESC LIMIT 100').all(agentPhone);
        },
        getUnbatchedPurchases(agentPhone) {
            return db.prepare('SELECT * FROM purchase_ledger WHERE agent_phone = ? AND batch_id IS NULL ORDER BY synced_at DESC').all(agentPhone);
        },
        getPurchase(id) {
            return db.prepare('SELECT * FROM purchase_ledger WHERE id = ?').get(id) || null;
        },
        // --- Batches ---
        createBatch(batch) {
            db.prepare(`INSERT INTO batches (id, agent_phone, batch_code, crop, total_quantity_kg, purchase_count, avg_moisture, overall_grade, status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .run(batch.id, batch.agent_phone, batch.batch_code, batch.crop,
                   batch.total_quantity_kg, batch.purchase_count,
                   batch.avg_moisture || null, batch.overall_grade || null,
                   'open', batch.created_at);
            // Assign purchases to batch
            if (batch.purchase_ids && batch.purchase_ids.length) {
                const update = db.prepare('UPDATE purchase_ledger SET batch_id = ? WHERE id = ?');
                db.transaction(() => {
                    for (const pid of batch.purchase_ids) update.run(batch.id, pid);
                })();
            }
        },
        getBatch(id) {
            return db.prepare('SELECT * FROM batches WHERE id = ?').get(id) || null;
        },
        getBatchByCode(code) {
            return db.prepare('SELECT * FROM batches WHERE batch_code = ?').get(code) || null;
        },
        getAgentBatches(agentPhone) {
            return db.prepare('SELECT * FROM batches WHERE agent_phone = ? ORDER BY created_at DESC LIMIT 50').all(agentPhone);
        },
        getBatchPurchases(batchId) {
            return db.prepare('SELECT * FROM purchase_ledger WHERE batch_id = ? ORDER BY synced_at DESC').all(batchId);
        },
        getBatchTraceability(batchId) {
            return db.prepare(`
                SELECT pl.*, p.name as farmer_name, p.parish, p.district
                FROM purchase_ledger pl
                LEFT JOIN profiles p ON pl.farmer_phone = p.phone
                WHERE pl.batch_id = ?
                ORDER BY pl.transaction_time
            `).all(batchId);
        },
        closeBatch(batchId) {
            db.prepare("UPDATE batches SET status = 'closed', closed_at = ? WHERE id = ?")
              .run(new Date().toISOString(), batchId);
        },
        sellBatch(batchId, salePrice, buyerPhone) {
            db.prepare("UPDATE batches SET status = 'sold', sale_price = ?, buyer_phone = ?, sold_at = ? WHERE id = ?")
              .run(salePrice, buyerPhone || null, new Date().toISOString(), batchId);
        },
        getAgentNearFarmer(farmerDistrict, excludePhone) {
            return db.prepare("SELECT * FROM agents WHERE status = 'active' AND district = ? AND phone != ? ORDER BY RANDOM() LIMIT 3")
              .all(farmerDistrict || 'Uganda', excludePhone || '');
        },
        // --- Warehouse Receipts ---
        lodgeBatch(receipt) {
            db.prepare(`INSERT INTO warehouse_receipts
                (id, batch_id, agent_phone, subcounty_location, facility_type, owner_name, photo_url, daily_storage_fee, date_lodged, notes)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .run(receipt.id, receipt.batch_id, receipt.agent_phone,
                   receipt.subcounty_location, receipt.facility_type || 'Rented Room',
                   receipt.owner_name || null, receipt.photo_url,
                   receipt.daily_storage_fee || 0, receipt.date_lodged,
                   receipt.notes || null);
            // Update batch status to 'warehoused'
            db.prepare("UPDATE batches SET status = 'warehoused' WHERE id = ? AND status = 'open'")
              .run(receipt.batch_id);
        },
        getWarehouseReceipt(batchId) {
            return db.prepare('SELECT * FROM warehouse_receipts WHERE batch_id = ?').get(batchId) || null;
        },
        getAgentWarehouseReceipts(agentPhone) {
            return db.prepare('SELECT wr.*, b.batch_code, b.crop, b.total_quantity_kg, b.overall_grade FROM warehouse_receipts wr JOIN batches b ON wr.batch_id = b.id WHERE wr.agent_phone = ? ORDER BY wr.date_lodged DESC').all(agentPhone);
        },
        withdrawBatch(batchId) {
            db.prepare("UPDATE warehouse_receipts SET date_withdrawn = ? WHERE batch_id = ?")
              .run(new Date().toISOString(), batchId);
        },
        // --- Aggregator Trust Score (2C) ---
        calculateTrustScore(agentPhone) {
            const agent = db.prepare('SELECT * FROM agents WHERE phone = ?').get(agentPhone);
            if (!agent) return null;
            if (agent.status !== 'active') return { phone: agentPhone, tier: 'INACTIVE', score: 0, details: {}, suspended: false };

            // Core metrics — all derived dynamically
            const purchases = db.prepare('SELECT COUNT(*) as c FROM purchase_ledger WHERE agent_phone = ?').get(agentPhone);
            const totalBatches = db.prepare('SELECT COUNT(*) as c FROM batches WHERE agent_phone = ?').get(agentPhone);
            const completedBatches = db.prepare("SELECT COUNT(*) as c FROM batches WHERE agent_phone = ? AND status IN ('sold', 'dispute_resolved')").get(agentPhone);
            const warehousedBatches = db.prepare("SELECT COUNT(*) as c FROM warehouse_receipts WHERE agent_phone = ?").get(agentPhone);
            const activeDisputes = db.prepare("SELECT COUNT(*) as c FROM batches WHERE agent_phone = ? AND status = 'disputed'").get(agentPhone);
            const totalDisputes = db.prepare("SELECT COUNT(*) as c FROM batches WHERE agent_phone = ? AND status IN ('disputed', 'dispute_resolved')").get(agentPhone);

            const purchaseCount = purchases.c;
            const completed = completedBatches.c;
            const warehoused = warehousedBatches.c;
            const activeDisputeCount = activeDisputes.c;
            const disputeTotal = totalDisputes.c;
            const disputeRatio = completed > 0 ? disputeTotal / completed : 0;
            const warehouseRatio = completed > 0 ? warehoused / completed : 0;

            // Determine tier
            let tier = 'NONE';
            let calculatedTier = 'NONE';

            // Bronze: KYC complete (agent is active) + at least 1 purchase
            if (purchaseCount >= 1) calculatedTier = 'BRONZE';

            // Silver: >5 completed batches + 0 unresolved disputes
            if (completed > 5 && activeDisputeCount === 0) calculatedTier = 'SILVER';

            // Gold: >20 completed + >50% warehoused + dispute ratio <5%
            if (completed > 20 && warehouseRatio > 0.5 && disputeRatio < 0.05) calculatedTier = 'GOLD';

            // KILLSWITCH: any active dispute freezes displayed tier
            const suspended = activeDisputeCount > 0;
            tier = suspended ? 'SUSPENDED' : calculatedTier;

            return {
                phone: agentPhone,
                name: agent.name,
                tier,
                calculated_tier: calculatedTier, // real tier, hidden during suspension
                suspended,
                details: {
                    purchases: purchaseCount,
                    total_batches: totalBatches.c,
                    completed_batches: completed,
                    warehoused_batches: warehoused,
                    warehouse_ratio: Math.round(warehouseRatio * 100),
                    active_disputes: activeDisputeCount,
                    total_disputes: disputeTotal,
                    dispute_ratio: Math.round(disputeRatio * 100)
                }
            };
        },
        // Dispute a batch (buyer-triggered)
        disputeBatch(batchId, reason) {
            const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
            if (!batch) return { error: 'Batch not found' };
            if (batch.status !== 'sold' && batch.status !== 'warehoused') {
                return { error: 'Only sold or warehoused batches can be disputed' };
            }
            db.prepare("UPDATE batches SET status = 'disputed' WHERE id = ?").run(batchId);
            // Log the dispute reason
            db.prepare('INSERT INTO agent_strikes (id, agent_phone, listing_id, farmer_phone, reason, time) VALUES (?,?,?,?,?,?)')
              .run(crypto.randomUUID(), batch.agent_phone, batchId, '', `Batch dispute: ${reason || 'Quality issue'}`, new Date().toISOString());
            return { success: true };
        },
        // Resolve a dispute (admin action)
        resolveDispute(batchId, resolution) {
            const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
            if (!batch) return { error: 'Batch not found' };
            if (batch.status !== 'disputed') return { error: 'Batch is not in disputed status' };
            db.prepare("UPDATE batches SET status = 'dispute_resolved' WHERE id = ?").run(batchId);
            return { success: true };
        },
        getWarehouseStorageCost(batchId) {
            const wr = db.prepare('SELECT * FROM warehouse_receipts WHERE batch_id = ?').get(batchId);
            if (!wr) return null;
            const lodged = new Date(wr.date_lodged);
            const end = wr.date_withdrawn ? new Date(wr.date_withdrawn) : new Date();
            const days = Math.max(1, Math.ceil((end - lodged) / (1000 * 60 * 60 * 24)));
            return { days, daily_fee: wr.daily_storage_fee, total_fee: days * wr.daily_storage_fee };
        },

        // ==========================================
        // ESCROW HELPERS
        // ==========================================
        createEscrow(batchId, buyerPhone, totalAmount) {
            const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
            if (!batch) return { error: 'Batch not found' };
            if (batch.status !== 'closed' && batch.status !== 'warehoused') return { error: 'Batch not available for sale' };
            const existing = db.prepare('SELECT * FROM escrow_transactions WHERE batch_id = ? AND status NOT IN (?, ?)').get(batchId, 'CANCELLED', 'RELEASED');
            if (existing) return { error: 'Batch already has an active escrow' };
            const platformFee = Math.round(totalAmount * 0.05);
            const agentPayout = totalAmount - platformFee;
            const id = crypto.randomUUID();
            db.prepare(`INSERT INTO escrow_transactions (id, batch_id, agent_phone, buyer_phone, total_amount, platform_fee, agent_payout, status, payout_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, batchId, batch.agent_phone, buyerPhone, totalAmount, platformFee, agentPayout, 'PENDING_PAYMENT', 'PENDING', new Date().toISOString());
            db.prepare("UPDATE batches SET buyer_phone = ?, status = 'funded' WHERE id = ?").run(buyerPhone, batchId);
            return { id, batch_id: batchId, agent_phone: batch.agent_phone, buyer_phone: buyerPhone, total_amount: totalAmount, platform_fee: platformFee, agent_payout: agentPayout, status: 'PENDING_PAYMENT' };
        },
        lockEscrow(escrowId, momoReference) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc) return { error: 'Escrow not found' };
            if (esc.status !== 'PENDING_PAYMENT') return { error: `Cannot lock escrow in ${esc.status} state` };
            const now = new Date().toISOString();
            db.prepare("UPDATE escrow_transactions SET status = 'FUNDS_LOCKED', momo_reference = ?, locked_at = ? WHERE id = ?").run(momoReference || 'SANDBOX_' + Date.now(), now, escrowId);
            return { ...esc, status: 'FUNDS_LOCKED', locked_at: now };
        },
        dispatchEscrow(escrowId, agentPhone, driverPhone, truckPlate) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc) return { error: 'Escrow not found' };
            if (esc.agent_phone !== agentPhone) return { error: 'Not your escrow' };
            if (esc.status !== 'FUNDS_LOCKED') return { error: `Cannot dispatch in ${esc.status} state` };
            if (!driverPhone || !driverPhone.trim()) return { error: 'Driver phone number is required' };
            if (!truckPlate || !truckPlate.trim()) return { error: 'Truck plate number is required' };
            const now = new Date().toISOString();
            db.prepare("UPDATE escrow_transactions SET status = 'IN_TRANSIT', dispatched_at = ?, driver_phone = ?, truck_plate_number = ? WHERE id = ?").run(now, driverPhone.trim(), truckPlate.trim().toUpperCase(), escrowId);
            db.prepare("UPDATE batches SET status = 'dispatched' WHERE id = ?").run(esc.batch_id);
            return { ...esc, status: 'IN_TRANSIT', dispatched_at: now, driver_phone: driverPhone.trim(), truck_plate_number: truckPlate.trim().toUpperCase() };
        },
        releaseEscrow(escrowId, buyerPhone) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc) return { error: 'Escrow not found' };
            if (esc.buyer_phone !== buyerPhone) return { error: 'Not your escrow' };
            if (esc.status !== 'IN_TRANSIT') return { error: `Cannot release in ${esc.status} state` };
            const now = new Date().toISOString();
            db.prepare("UPDATE escrow_transactions SET status = 'RELEASED', payout_status = 'RELEASED', released_at = ? WHERE id = ?").run(now, escrowId);
            db.prepare("UPDATE batches SET status = 'received', sold_at = ? WHERE id = ?").run(now, esc.batch_id);
            return { ...esc, status: 'RELEASED', released_at: now };
        },
        cancelEscrow(escrowId, phone) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc) return { error: 'Escrow not found' };
            if (esc.buyer_phone !== phone && phone !== 'ADMIN') return { error: 'Only buyer or admin can cancel' };
            if (esc.status === 'RELEASED' || esc.status === 'CANCELLED') return { error: `Cannot cancel in ${esc.status} state` };
            if (esc.status === 'IN_TRANSIT') return { error: 'Cannot cancel after dispatch — file a dispute instead' };
            // 4-hour cancel window: buyer can only cancel within 4h of funds being locked
            if (esc.status === 'FUNDS_LOCKED' && esc.locked_at && phone !== 'ADMIN') {
                const hoursSinceLock = (Date.now() - new Date(esc.locked_at).getTime()) / (1000 * 60 * 60);
                if (hoursSinceLock > 4) return { error: 'Cancel window expired (4 hours). Contact admin for assistance.' };
            }
            const now = new Date().toISOString();
            db.prepare("UPDATE escrow_transactions SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?").run(now, escrowId);
            db.prepare("UPDATE batches SET buyer_phone = NULL, status = 'closed' WHERE id = ?").run(esc.batch_id);
            return { ...esc, status: 'CANCELLED', cancelled_at: now };
        },
        disputeEscrow(escrowId, phone, reason) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc) return { error: 'Escrow not found' };
            if (esc.buyer_phone !== phone) return { error: 'Only buyer can dispute' };
            if (esc.status !== 'IN_TRANSIT' && esc.status !== 'FUNDS_LOCKED') return { error: `Cannot dispute in ${esc.status} state` };
            db.prepare("UPDATE escrow_transactions SET status = 'DISPUTED', notes = ? WHERE id = ?").run(reason, escrowId);
            helpers.disputeBatch(esc.batch_id, reason);
            return { ...esc, status: 'DISPUTED' };
        },
        adminResolveEscrow(escrowId, action, notes, releasePercentage) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc) return { error: 'Escrow not found' };
            if (esc.status !== 'DISPUTED') return { error: 'Escrow not in DISPUTED state' };
            const now = new Date().toISOString();
            if (action === 'partial') {
                const pct = Number(releasePercentage);
                if (isNaN(pct) || pct < 0 || pct > 100) return { error: 'release_percentage must be 0-100' };
                const releasedAmount = Math.round(esc.agent_payout * pct / 100);
                const refundedAmount = esc.agent_payout - releasedAmount;
                const resolveNotes = `Partial: ${pct}% released (UGX ${releasedAmount}), ${100 - pct}% refunded (UGX ${refundedAmount}). ${notes || ''}`.trim();
                db.prepare("UPDATE escrow_transactions SET status = 'RELEASED', payout_status = 'PARTIAL', released_at = ?, notes = ?, agent_payout = ? WHERE id = ?").run(now, resolveNotes, releasedAmount, escrowId);
                db.prepare("UPDATE batches SET status = 'received', sold_at = ? WHERE id = ?").run(now, esc.batch_id);
                helpers.resolveDispute(esc.batch_id, resolveNotes);
                return { success: true, action: 'partial', release_percentage: pct, released_amount: releasedAmount, refunded_amount: refundedAmount };
            } else if (action === 'release') {
                db.prepare("UPDATE escrow_transactions SET status = 'RELEASED', payout_status = 'RELEASED', released_at = ?, notes = ? WHERE id = ?").run(now, notes || esc.notes, escrowId);
                db.prepare("UPDATE batches SET status = 'received', sold_at = ? WHERE id = ?").run(now, esc.batch_id);
                helpers.resolveDispute(esc.batch_id, 'Admin released: ' + (notes || ''));
            } else {
                db.prepare("UPDATE escrow_transactions SET status = 'CANCELLED', cancelled_at = ?, notes = ? WHERE id = ?").run(now, notes || esc.notes, escrowId);
                db.prepare("UPDATE batches SET buyer_phone = NULL, status = 'closed' WHERE id = ?").run(esc.batch_id);
                helpers.resolveDispute(esc.batch_id, 'Admin refunded: ' + (notes || ''));
            }
            return { success: true, action };
        },
        getEscrow(escrowId) {
            return db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId) || null;
        },
        getEscrowByBatch(batchId) {
            return db.prepare("SELECT * FROM escrow_transactions WHERE batch_id = ? AND status NOT IN ('CANCELLED') ORDER BY created_at DESC LIMIT 1").get(batchId) || null;
        },
        getBuyerEscrows(buyerPhone) {
            return db.prepare('SELECT e.*, b.crop, b.total_quantity_kg, b.batch_code FROM escrow_transactions e JOIN batches b ON e.batch_id = b.id WHERE e.buyer_phone = ? ORDER BY e.created_at DESC').all(buyerPhone);
        },
        getAgentEscrows(agentPhone) {
            return db.prepare('SELECT e.*, b.crop, b.total_quantity_kg, b.batch_code FROM escrow_transactions e JOIN batches b ON e.batch_id = b.id WHERE e.agent_phone = ? ORDER BY e.created_at DESC').all(agentPhone);
        },
        getMarketplaceBatches() {
            return db.prepare(`
                SELECT b.id, b.batch_code, b.crop, b.total_quantity_kg, b.purchase_count,
                       b.overall_grade, b.status, b.created_at, b.sale_price,
                       a.district as agent_district
                FROM batches b
                JOIN agents a ON b.agent_phone = a.phone
                WHERE b.status IN ('closed', 'warehoused')
                AND b.id NOT IN (SELECT batch_id FROM escrow_transactions WHERE status NOT IN ('CANCELLED', 'RELEASED'))
                ORDER BY b.created_at DESC
            `).all();
        },
        getMarketplaceBatchDetail(batchId) {
            const batch = db.prepare(`
                SELECT b.*, a.district as agent_district
                FROM batches b
                JOIN agents a ON b.agent_phone = a.phone
                WHERE b.id = ?
            `).get(batchId);
            if (!batch) return null;
            const wr = db.prepare('SELECT subcounty_location, facility_type, photo_url FROM warehouse_receipts WHERE batch_id = ?').get(batchId);
            const trust = helpers.calculateTrustScore(batch.agent_phone);
            return { ...batch, warehouse: wr || null, agent_trust_tier: trust.tier };
        },
        getStaleEscrows() {
            const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
            return db.prepare("SELECT * FROM escrow_transactions WHERE status = 'FUNDS_LOCKED' AND locked_at < ?").all(cutoff);
        },

        // ==========================================
        // DISPATCH SLA (24h auto-cancel, 20h warning)
        // ==========================================
        getDispatchWarningEscrows() {
            // FUNDS_LOCKED for 20-24h — need SMS warning
            const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const to = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
            return db.prepare("SELECT * FROM escrow_transactions WHERE status = 'FUNDS_LOCKED' AND locked_at < ? AND locked_at >= ?").all(to, from);
        },
        getDispatchExpiredEscrows() {
            // FUNDS_LOCKED for 24h+ — auto-cancel
            const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            return db.prepare("SELECT * FROM escrow_transactions WHERE status = 'FUNDS_LOCKED' AND locked_at < ?").all(cutoff);
        },
        autoExpireEscrow(escrowId) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc || esc.status !== 'FUNDS_LOCKED') return null;
            const now = new Date().toISOString();
            db.prepare("UPDATE escrow_transactions SET status = 'CANCELLED', cancelled_at = ?, notes = 'Auto-cancelled: agent failed 24h dispatch SLA' WHERE id = ?").run(now, escrowId);
            db.prepare("UPDATE batches SET buyer_phone = NULL, status = 'closed' WHERE id = ?").run(esc.batch_id);
            // Ding agent trust score
            helpers.disputeBatch(esc.batch_id, 'Dispatch SLA breach: 24h expiry');
            helpers.resolveDispute(esc.batch_id, 'Auto-cancelled: agent missed dispatch window');
            return { ...esc, status: 'CANCELLED', cancelled_at: now };
        },

        // ==========================================
        // DELIVERY TIMEOUT (IN_TRANSIT 72h+ — buyer ghosting)
        // ==========================================
        getDeliveryTimeoutEscrows() {
            const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
            return db.prepare("SELECT * FROM escrow_transactions WHERE status = 'IN_TRANSIT' AND dispatched_at < ?").all(cutoff);
        },

        // ==========================================
        // ADMIN OPS HELPERS
        // ==========================================
        getArbitrationQueue() {
            return db.prepare(`
                SELECT e.*, b.crop, b.total_quantity_kg, b.batch_code, b.overall_grade,
                       a.name as agent_name, a.district as agent_district
                FROM escrow_transactions e
                JOIN batches b ON e.batch_id = b.id
                JOIN agents a ON e.agent_phone = a.phone
                WHERE e.status IN ('DISPUTED', 'FUNDS_LOCKED', 'IN_TRANSIT')
                AND (
                    e.status = 'DISPUTED'
                    OR (e.status = 'FUNDS_LOCKED' AND e.locked_at < ?)
                    OR (e.status = 'IN_TRANSIT' AND e.dispatched_at < ?)
                )
                ORDER BY
                    CASE e.status WHEN 'DISPUTED' THEN 0 ELSE 1 END,
                    e.created_at ASC
            `).all(
                new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
                new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
            ).map(e => {
                const wr = db.prepare('SELECT subcounty_location, facility_type, photo_url FROM warehouse_receipts WHERE batch_id = ?').get(e.batch_id);
                const trust = helpers.calculateTrustScore(e.agent_phone);
                const queueType = e.status === 'DISPUTED' ? 'DISPUTED'
                    : e.status === 'FUNDS_LOCKED' ? 'STALE'
                    : 'DELIVERY_TIMEOUT';
                return { ...e, warehouse: wr || null, agent_trust: trust, queue_type: queueType };
            });
        },
        getPendingPayouts() {
            const rows = db.prepare(`
                SELECT e.*, b.crop, b.total_quantity_kg, b.batch_code,
                       a.name as agent_name, a.district as agent_district
                FROM escrow_transactions e
                JOIN batches b ON e.batch_id = b.id
                JOIN agents a ON e.agent_phone = a.phone
                WHERE e.status = 'RELEASED' AND e.payout_status IN ('RELEASED', 'PARTIAL')
                ORDER BY e.released_at ASC
            `).all();
            // Enrich with wait time for admin prioritization
            const now = Date.now();
            return rows.map(r => {
                const waitMs = now - new Date(r.released_at).getTime();
                const waitHours = Math.round(waitMs / (1000 * 60 * 60) * 10) / 10;
                return { ...r, wait_hours: waitHours, urgent: waitHours >= 12 };
            });
        },
        getPayoutHistory(limit = 50) {
            return db.prepare(`
                SELECT e.id, e.batch_id, e.agent_phone, e.agent_payout, e.platform_fee,
                       e.payout_status, e.released_at, e.disbursed_at, e.disbursement_ref,
                       b.crop, b.total_quantity_kg, b.batch_code,
                       a.name as agent_name
                FROM escrow_transactions e
                JOIN batches b ON e.batch_id = b.id
                JOIN agents a ON e.agent_phone = a.phone
                WHERE e.payout_status = 'DISBURSED'
                ORDER BY e.disbursed_at DESC
                LIMIT ?
            `).all(limit);
        },
        disburseEscrow(escrowId, disbursementRef) {
            const esc = db.prepare('SELECT * FROM escrow_transactions WHERE id = ?').get(escrowId);
            if (!esc) return { error: 'Escrow not found' };
            if (esc.status !== 'RELEASED') return { error: 'Escrow not in RELEASED state' };
            if (esc.payout_status === 'DISBURSED') return { error: 'Already disbursed' };
            if (!disbursementRef || !disbursementRef.trim()) return { error: 'Disbursement reference (MoMo receipt) is required' };
            const now = new Date().toISOString();
            db.prepare("UPDATE escrow_transactions SET payout_status = 'DISBURSED', disbursed_at = ?, disbursement_ref = ? WHERE id = ?").run(now, disbursementRef.trim(), escrowId);
            return { ...esc, payout_status: 'DISBURSED', disbursed_at: now, disbursement_ref: disbursementRef.trim() };
        },
        getAdminStats() {
            const total = db.prepare('SELECT COUNT(*) as c FROM escrow_transactions').get().c;
            const active = db.prepare("SELECT COUNT(*) as c FROM escrow_transactions WHERE status IN ('PENDING_PAYMENT','FUNDS_LOCKED','IN_TRANSIT')").get().c;
            const released = db.prepare("SELECT COUNT(*) as c FROM escrow_transactions WHERE status = 'RELEASED'").get().c;
            const disputed = db.prepare("SELECT COUNT(*) as c FROM escrow_transactions WHERE status = 'DISPUTED'").get().c;
            const cancelled = db.prepare("SELECT COUNT(*) as c FROM escrow_transactions WHERE status = 'CANCELLED'").get().c;
            const disbursed = db.prepare("SELECT COUNT(*) as c FROM escrow_transactions WHERE payout_status = 'DISBURSED'").get().c;
            const pendingPayout = db.prepare("SELECT COUNT(*) as c FROM escrow_transactions WHERE status = 'RELEASED' AND payout_status IN ('RELEASED','PARTIAL')").get().c;
            const totalRevenue = db.prepare("SELECT COALESCE(SUM(platform_fee),0) as s FROM escrow_transactions WHERE status = 'RELEASED'").get().s;
            const totalVolume = db.prepare("SELECT COALESCE(SUM(total_amount),0) as s FROM escrow_transactions WHERE status NOT IN ('CANCELLED')").get().s;
            return { total, active, released, disputed, cancelled, disbursed, pending_payout: pendingPayout, total_revenue: totalRevenue, total_volume: totalVolume };
        }
    };
    return helpers;
}

// ==========================================
// APP FACTORY
// ==========================================
function createApp(db, sms, opts) {
    const adminSecret = opts?.adminSecret || process.env.ADMIN_SECRET || '';
    const notify = createNotifier(opts?.discordWebhook || process.env.DISCORD_WEBHOOK_URL);

    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
    });

    // Request logger — logs all /api and /ussd hits for pilot observability
    const logInsert = db.prepare('INSERT INTO request_log (timestamp, method, path, phone, status_code, duration_ms, error, type) VALUES (?,?,?,?,?,?,?,?)');
    app.use((req, res, next) => {
        if (!req.path.startsWith('/api') && !req.path.startsWith('/ussd')) return next();
        const start = Date.now();
        const origEnd = res.end;
        res.end = function(...args) {
            const duration = Date.now() - start;
            const phone = req.headers['x-phone'] || req.body?.phone || req.body?.phoneNumber || '';
            const type = req.path.startsWith('/ussd') ? 'USSD' : 'API';
            try { logInsert.run(new Date().toISOString(), req.method, req.path, phone, res.statusCode, duration, null, type); } catch (_) {}
            origEnd.apply(this, args);
        };
        next();
    });

    app.use('/app', express.static(path.join(__dirname, '..', 'public')));

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
    app.use('/uploads', express.static(uploadsDir));

    const helpers = createHelpers(db);
    helpers._notify = notify; // expose for API routes
    const { getProfile, saveProfile, addListing, getListing, getApprovedListings, getAllListings, updateListingStatus, getVerification, getPrices, getPricesMap, setPrices, getAllAgents, setAgentStatus } = helpers;

    app.use('/api', createApiRouter(db, sms, sendSms, helpers, uploadsDir, opts));

    // ==========================================
    // USSD HELPERS
    // ==========================================
    function deriveUnit(detail) {
        const d = detail.toLowerCase();
        if (d.includes('bunch')) return 'per bunch';
        if (d.includes('basin')) return 'per basin';
        if (d.includes('tin')) return 'per tin';
        if (d.includes('bag')) return 'per bag';
        if (d.includes('sack')) return 'per sack';
        if (d.includes('crate')) return 'per crate';
        return 'per kg';
    }

    // ==========================================
    // USSD ENDPOINT
    // ==========================================
    app.post('/ussd', (req, res) => {
        try {
            const phoneNumber = req.body.phoneNumber || "Unknown";
            const rawText = req.body.text || "";
            let parts = rawText.split('*').filter(p => p !== "");
            const text = parts.join('*');

            let profile = getProfile(phoneNumber);
            let response = "";

            // Crop code map — numeric codes for fast feature-phone input (Agent USSD Purchase)
            const CROP_CODES = {
                '1': 'Maize', '2': 'Beans', '3': 'Rice', '4': 'Coffee',
                '5': 'Cassava', '6': 'G-Nuts', '7': 'Sorghum', '8': 'Millet',
                '9': 'Matooke', '10': 'Soya Beans', '11': 'Sesame (Simsim)',
                '12': 'Sweet Potatoes', '13': 'Irish Potatoes',
                '14': 'Tomatoes', '15': 'Onions'
            };

            // ==========================================
            // 0. MAIN MENU
            // ==========================================
            if (text === "") {
                response = `CON Welcome to Agri-Bridge
1. I am a Farmer (Village)
2. I am a Broker (City Vendor)
3. I am a Buyer
4. Check Market Prices
5. My Listings
6. Rate a Seller
7. Agent Purchase`;
            }

            // ==========================================
            // 1. FARMER FLOW (Smart Triage)
            // ==========================================
            else if (text === "1") {
                if (!profile) {
                    response = `CON Welcome! Please Register:
Enter Name-Parish-District
(e.g. Kato-Kibibi-Mityana):`;
                } else {
                    response = `CON Welcome back, ${profile.name}!
1. List Produce (${profile.parish})`;
                }
            }
            else if (text.startsWith("1*") && !profile) {
                const rawInput = parts[1] || "";
                if (!rawInput.includes('-')) {
                    response = `CON Invalid format. Please enter Name-Parish-District
(e.g. Kato-Kibibi-Mityana):`;
                } else {
                    const regData = rawInput.split('-');
                    const name = regData[0]?.trim();
                    if (!name) {
                        response = `CON Name cannot be empty. Please enter Name-Parish-District:`;
                    } else {
                        const parish = regData[1]?.trim() || "Unknown";
                        saveProfile(phoneNumber, name, parish, regData[2]?.trim() || "Uganda");
                        response = `CON Profile Created! Welcome, ${name}!
1. List Produce (${parish})`;
                    }
                }
            }
            // Show listing prompt — handles returning user (text="1*1") and
            // newly-registered user in same session (text="1*regdata*1")
            else if (parts[0] === "1" && profile &&
                     parts[parts.length - 1] === "1" &&
                     (parts.length === 2 || parts.length === 3)) {
                response = `CON Listing from ${profile.parish}:
Enter Crop & Qty (e.g. Maize 50kg):`;
            }
            // After crop entered — ask for price
            // Returning user: parts.length=3, new user: parts.length=4
            else if (parts[0] === "1" && profile &&
                     parts[parts.length - 2] === "1" &&
                     (parts.length === 3 || parts.length === 4)) {
                const detail = parts[parts.length - 1];
                const unit = deriveUnit(detail);
                response = `CON Your price ${unit}? (UGX)
e.g. 1200`;
            }
            // After price entered — ask for total stock
            // Returning user: parts.length=4, new user: parts.length=5
            else if (parts[0] === "1" && profile &&
                     parts[parts.length - 3] === "1" &&
                     (parts.length === 4 || parts.length === 5)) {
                response = `CON Total stock available?
(e.g. 500kg)`;
            }
            // After stock entered — submit listing
            // Returning user: parts.length=5, new user: parts.length=6
            else if (parts[0] === "1" && profile &&
                     parts[parts.length - 4] === "1" &&
                     (parts.length === 5 || parts.length === 6)) {
                const detail = parts[parts.length - 3];
                const askingPrice = parseInt(parts[parts.length - 2]) || null;
                const stock = parts[parts.length - 1];
                const priceUnit = deriveUnit(detail);
                let quantityMatch = detail.match(/\d+/);
                let quantityAmount = quantityMatch ? parseInt(quantityMatch[0]) : 999;

                const status = "[APPROVED]";
                const needsVerify = quantityAmount >= 100;

                addListing({
                    id: crypto.randomUUID(),
                    time: new Date().toLocaleString(),
                    phone: phoneNumber,
                    detail: detail,
                    location: profile.parish,
                    type: "VILLAGE",
                    status: status,
                    asking_price: askingPrice,
                    price_unit: priceUnit,
                    stock: stock
                });

                response = `END Your listing is LIVE!
${askingPrice ? 'Price: UGX ' + Number(askingPrice).toLocaleString() + ' ' + priceUnit : ''}
${needsVerify ? "Large qty — a field agent will visit to verify & boost trust." : "Listed & live on the market board."}`;
            }

            // ==========================================
            // 2. BROKER FLOW (City Wholesale)
            // ==========================================
            else if (text === "2") {
                response = `CON Broker Menu:
1. List City Wholesale (Nakasero)`;
            }
            else if (text === "2*1") {
                response = `CON Enter Crop & Qty (e.g. Matooke 500bunches):`;
            }
            // After crop — ask price
            else if (text.startsWith("2*1*") && parts.length === 3) {
                const detail = parts[2];
                const unit = deriveUnit(detail);
                response = `CON Wholesale price ${unit}? (UGX)
e.g. 15000`;
            }
            // After price — ask stock
            else if (text.startsWith("2*1*") && parts.length === 4) {
                response = `CON Total stock available?
(e.g. 2000bunches)`;
            }
            // After stock — submit
            else if (text.startsWith("2*1*") && parts.length === 5) {
                const detail = parts[2];
                const askingPrice = parseInt(parts[3]) || null;
                const stock = parts[4];
                const priceUnit = deriveUnit(detail);
                addListing({
                    id: crypto.randomUUID(),
                    time: new Date().toLocaleString(),
                    phone: phoneNumber,
                    detail: detail,
                    location: "City Market",
                    type: "CITY",
                    status: "[APPROVED]",
                    asking_price: askingPrice,
                    price_unit: priceUnit,
                    stock: stock
                });
                response = `END Success! City wholesale stock is live.
${askingPrice ? 'Price: UGX ' + Number(askingPrice).toLocaleString() + ' ' + priceUnit : ''}`;
            }

            // ==========================================
            // 3. BUYER FLOW (Individual Registration)
            // ==========================================
            else if (text === "3") {
                response = `CON Buyer Menu:
1. Browse Listings
2. Register (new buyers)`;
            }
            // 3*1 — Browse listings submenu
            else if (text === "3*1") {
                response = `CON Select Market:
1. Farm Gate (Village Prices)
2. City Markets (Wholesale)`;
            }
            // 3*1*1 or 3*1*2 — prompt for PIN
            else if ((text === "3*1*1" || text === "3*1*2") && parts.length === 3) {
                response = `CON Enter your 4-digit PIN:`;
            }
            // 3*1*1*XXXX or 3*1*2*XXXX — authenticate and show listings
            else if ((text.startsWith("3*1*1*") || text.startsWith("3*1*2*")) && parts.length === 4) {
                const buyer = helpers.authenticateBuyer(phoneNumber, parts[3]);
                if (!buyer) {
                    response = `END Invalid PIN or not registered. Dial back, option 3>2 to register.`;
                } else {
                    const boardType = parts[2] === "1" ? "VILLAGE" : "CITY";
                    const active = getApprovedListings(boardType);
                    if (active.length === 0) {
                        response = `END No active listings right now.`;
                    } else {
                        let listText = "END Market Listings:\n";
                        active.forEach(l => {
                            const prof = getProfile(l.phone);
                            const location = prof ? prof.district : l.location;
                            const trust = helpers.getFarmerTrustLabel(l.phone);
                            listText += `${l.detail} - ${location} ${trust}\n`;
                        });
                        response = listText;
                    }
                }
            }
            // 3*2 — Register: ask name
            else if (text === "3*2") {
                response = `CON Enter your name:`;
            }
            // 3*2*Name — ask for PIN
            else if (text.startsWith("3*2*") && parts.length === 3) {
                response = `CON Create a 4-digit PIN:`;
            }
            // 3*2*Name*PIN — confirm PIN
            else if (text.startsWith("3*2*") && parts.length === 4) {
                if (!/^\d{4}$/.test(parts[3])) {
                    response = `END PIN must be exactly 4 digits. Try again.`;
                } else {
                    response = `CON Confirm your PIN:`;
                }
            }
            // 3*2*Name*PIN*Confirm — send OTP
            else if (text.startsWith("3*2*") && parts.length === 5) {
                const name = parts[2];
                const pin = parts[3];
                const confirm = parts[4];
                if (pin !== confirm) {
                    response = `END PINs don't match. Dial back and try again.`;
                } else {
                    const code = helpers.generateOtp();
                    helpers.storeOtp(phoneNumber, code, 'buyer_ussd', { name, pin });
                    sendSms(sms, phoneNumber, `Agri-Bridge: Your verification code is ${code}`);
                    response = `CON SMS code sent! Enter the 6-digit code:`;
                }
            }
            // 3*2*Name*PIN*Confirm*OTP — verify and register
            else if (text.startsWith("3*2*") && parts.length === 6) {
                const otpCode = parts[5];
                const result = helpers.verifyOtp(phoneNumber, otpCode, 'buyer_ussd');
                if (result.error) {
                    response = `END ${result.error}`;
                } else {
                    const { name, pin } = result.payload;
                    const reg = helpers.registerBuyer(phoneNumber, name, pin);
                    if (reg.error) {
                        response = `END ${reg.error}`;
                    } else {
                        response = `END Registered successfully! Dial back, choose Browse Listings.`;
                    }
                }
            }

            // ==========================================
            // 4. PRICE CHECKER (FULLY DYNAMIC)
            // ==========================================
            else if (text === "4") {
                const prices = getPrices();
                let priceText = "END Today's Prices (UGX):\n";
                for (const p of prices) {
                    priceText += `${p.crop}: ${p.price} ${p.unit}\n`;
                }
                response = priceText;
            }

            // ==========================================
            // 5. MY LISTINGS (Farmer transparency)
            // ==========================================
            // 6. RATE A SELLER (Buyer feedback)
            // ==========================================
            else if (text === "6") {
                response = `CON Rate a seller you bought from.
Enter seller's phone number:`;
            }
            else if (text.startsWith("6*") && parts.length === 2) {
                const sellerPhone = parts[1];
                const sellerProfile = getProfile(sellerPhone);
                if (!sellerProfile) {
                    response = `END Seller not found. Check the number.`;
                } else {
                    const recent = helpers.getRecentListings(sellerPhone, 3);
                    if (!recent.length) {
                        response = `END ${sellerProfile.name} has no active listings to rate.`;
                    } else {
                        let menu = `CON ${sellerProfile.name}'s listings:\n`;
                        recent.forEach((l, i) => {
                            menu += `${i + 1}. ${l.detail} (${l.location})\n`;
                        });
                        response = menu;
                    }
                }
            }
            else if (text.startsWith("6*") && parts.length === 3) {
                const sellerPhone = parts[1];
                const choice = parseInt(parts[2]);
                const recent = helpers.getRecentListings(sellerPhone, 3);
                if (!choice || choice < 1 || choice > recent.length) {
                    response = `END Invalid choice.`;
                } else {
                    response = `CON Rate this listing:
1. Excellent (5)
2. Good (4)
3. Fair (3)
4. Poor (2)
5. Scam (1)`;
                }
            }
            else if (text.startsWith("6*") && parts.length === 4) {
                const sellerPhone = parts[1];
                const listingIdx = parseInt(parts[2]) - 1;
                const recent = helpers.getRecentListings(sellerPhone, 3);
                const ratingMap = { '1': 5, '2': 4, '3': 3, '4': 2, '5': 1 };
                const rating = ratingMap[parts[3]];
                if (!rating || listingIdx < 0 || listingIdx >= recent.length) {
                    response = `END Invalid choice.`;
                } else {
                    const listing = recent[listingIdx];
                    const result = helpers.addFeedback(listing.id, listing.phone, phoneNumber, rating, '');
                    if (result.error) {
                        response = `END ${result.error}`;
                    } else {
                        const rep = helpers.getFarmerReputation(sellerPhone);
                        response = `END Thank you! Rating saved.
${sellerPhone} now has ${rep.avg}/5 from ${rep.sales} buyer(s).`;
                    }
                }
            }

            //
            // ==========================================
            else if (text === "5") {
                const myListings = getAllListings().filter(l => l.phone === phoneNumber);
                if (!myListings.length) {
                    response = `END You have no listings yet.`;
                } else {
                    let txt = "END Your Listings:\n";
                    myListings.slice(0, 5).forEach(l => {
                        const v = helpers.getVerification(l.id);
                        const badge = v ? `[VERIFIED Grade ${v.grade}]` : '[UNVERIFIED]';
                        txt += `${l.detail} ${badge}\n`;
                    });
                    txt += `\nTotal: ${myListings.length} listing(s)`;
                    response = txt;
                }
            }

            // ==========================================
            // 7. AGENT PURCHASE (USSD Fallback — offline survival)
            // ==========================================

            // Step 1: Enter PIN
            else if (text === "7") {
                response = `CON Agent Purchase (Offline Mode)
Enter your 4-digit PIN:`;
            }
            // Step 2: Authenticate, show crop codes
            else if (text.startsWith("7*") && parts.length === 2) {
                const agentPin = parts[1];
                const auth = helpers.authenticateAgent(phoneNumber, agentPin);
                if (auth.error) {
                    response = `END ${auth.error}`;
                } else {
                    response = `CON Crop Code:
1.Maize 2.Beans 3.Rice
4.Coffee 5.Cassava 6.G-Nuts
7.Sorghum 8.Millet 9.Matooke
10.Soya 11.Simsim 12.S.Potato
Enter code:`;
                }
            }
            // Step 3: Ask quantity
            else if (text.startsWith("7*") && parts.length === 3) {
                const cropCode = parts[2];
                if (!CROP_CODES[cropCode]) {
                    response = `END Invalid crop code. Dial back and try again.`;
                } else {
                    response = `CON ${CROP_CODES[cropCode]}
Enter quantity (kg):`;
                }
            }
            // Step 4: Ask price per kg
            else if (text.startsWith("7*") && parts.length === 4) {
                const qty = parseFloat(parts[3]);
                if (isNaN(qty) || qty <= 0) {
                    response = `END Invalid quantity. Dial back and try again.`;
                } else {
                    response = `CON ${qty}kg noted.
Price per kg (UGX):`;
                }
            }
            // Step 5: Ask farmer phone
            else if (text.startsWith("7*") && parts.length === 5) {
                const price = parseInt(parts[4]);
                if (isNaN(price) || price <= 0) {
                    response = `END Invalid price. Dial back and try again.`;
                } else {
                    response = `CON Farmer's phone number:
(e.g. +256771234567)`;
                }
            }
            // Step 6: Confirm and log purchase
            else if (text.startsWith("7*") && parts.length === 6) {
                const agentPin = parts[1];
                const auth = helpers.authenticateAgent(phoneNumber, agentPin);
                if (auth.error) {
                    response = `END Session error. Dial back.`;
                } else {
                    const cropName = CROP_CODES[parts[2]];
                    const qty = parseFloat(parts[3]);
                    const price = parseInt(parts[4]);
                    const farmerPhone = parts[5];

                    if (!cropName || isNaN(qty) || isNaN(price)) {
                        response = `END Invalid data. Dial back and try again.`;
                    } else {
                        const farmer = helpers.getProfile(farmerPhone);
                        if (!farmer) {
                            response = `END Farmer ${farmerPhone} not registered. They must dial in and register first.`;
                        } else {
                            const totalPrice = Math.round(qty * price);
                            const purchase = {
                                id: crypto.randomUUID(),
                                agent_phone: auth.agent.phone,
                                farmer_phone: farmerPhone,
                                listing_id: null,
                                crop: cropName,
                                quantity_kg: qty,
                                unit_price: price,
                                total_price: totalPrice,
                                price_unit: 'per kg',
                                grade: null,
                                moisture_level: null,
                                transaction_time: new Date().toISOString(),
                                synced_at: new Date().toISOString(),
                                lat: null, lng: null,
                                notes: 'USSD purchase'
                            };
                            helpers.logPurchase(purchase);

                            // SMS receipt to farmer (fire-and-forget, don't block USSD response)
                            const agentName = auth.agent.name || phoneNumber;
                            sendSms(sms, farmerPhone, `Agri-Bridge: Agent ${agentName} purchased ${qty}kg ${cropName} from you for ${totalPrice.toLocaleString()} UGX. Ref: ${purchase.id.slice(0, 8)}`);

                            response = `END Purchase logged!
${qty}kg ${cropName} @ ${price}/kg
Total: ${totalPrice.toLocaleString()} UGX
Farmer: ${farmer.name}
SMS receipt sent to ${farmerPhone}
Ref: ${purchase.id.slice(0, 8)}`;
                        }
                    }
                }
            }

            if (response === "") {
                response = `CON Invalid option.\n0. Main Menu`;
            }

            res.set("Content-Type", "text/plain");
            res.send(response);
        } catch (err) {
            console.error(err);
            res.send("END Connection Error.");
        }
    });

    // ==========================================
    // COMMAND CENTER INTERFACE & API
    // ==========================================
    app.get('/', (req, res) => {
        const csrfToken = generateCsrfToken();
        res.setHeader('Set-Cookie', `csrf_token=${csrfToken}; Path=/; SameSite=Strict; HttpOnly`);
        let rows = "";
        const listings = getAllListings();
        listings.forEach(l => {
            const isPending = l.status === '[PENDING]';
            const statusColor = isPending ? "#f39c12" : "#27ae60";
            const safeId = escapeHtml(l.id);

            const actionButtons = isPending
                ? `<button onclick="updateStatus('${safeId}', '[APPROVED]')" style="background:#27ae60; color:white; padding:5px 10px; border:none; border-radius:3px; cursor:pointer;">Approve</button>
                   <button onclick="updateStatus('${safeId}', '[REJECTED]')" style="background:#e74c3c; color:white; padding:5px 10px; border:none; border-radius:3px; cursor:pointer; margin-left:5px;">Reject</button>`
                : `<span style="color:#7f8c8d; font-size: 0.9em;">Resolved</span>`;

            rows += `<tr style="background: white; border-bottom: 1px solid #ddd;">
                <td style="padding: 10px;">${escapeHtml(l.time)}</td>
                <td style="padding: 10px; font-weight: bold;">${escapeHtml(l.phone)}</td>
                <td style="padding: 10px;">${escapeHtml(l.detail)}</td>
                <td style="padding: 10px;">${escapeHtml(l.location)}</td>
                <td style="padding: 10px; color: ${statusColor}; font-weight: bold;">${escapeHtml(l.status)}</td>
                <td style="padding: 10px;">${actionButtons}</td>
            </tr>`;
        });

        const prices = getPrices();
        let priceInputs = prices.map(p => `
            <div data-crop="${escapeHtml(p.crop.toLowerCase())}" style="margin-bottom: 10px;">
                <label style="font-size: 12px; color: #666; font-weight: bold;">${escapeHtml(p.crop)} (${escapeHtml(p.unit)})</label><br>
                <input type="text" name="${escapeHtml(p.crop)}" value="${escapeHtml(p.price)}" style="padding:8px; width:120px; border:1px solid #ccc; border-radius:4px;">
            </div>
        `).join('');

        // Build agent management rows
        const agentsList = getAllAgents();
        let agentRows = '';
        agentsList.forEach(a => {
            const statusColor = a.status === 'active' ? '#27ae60' : a.status === 'suspended' ? '#e74c3c' : '#f39c12';
            const actions = a.status === 'pending'
                ? `<button onclick="agentAction('${escapeHtml(a.phone)}', 'active')" style="background:#27ae60;color:white;padding:4px 10px;border:none;border-radius:3px;cursor:pointer;">Approve</button>`
                : a.status === 'active'
                ? `<button onclick="agentAction('${escapeHtml(a.phone)}', 'suspended')" style="background:#e74c3c;color:white;padding:4px 10px;border:none;border-radius:3px;cursor:pointer;">Suspend</button>`
                : `<button onclick="agentAction('${escapeHtml(a.phone)}', 'active')" style="background:#27ae60;color:white;padding:4px 10px;border:none;border-radius:3px;cursor:pointer;">Reactivate</button>`;
            agentRows += `<tr style="background:white;border-bottom:1px solid #ddd;">
                <td style="padding:8px;">${escapeHtml(a.phone)}</td>
                <td style="padding:8px;font-weight:bold;">${escapeHtml(a.name)}</td>
                <td style="padding:8px;">${escapeHtml(a.district || '-')}</td>
                <td style="padding:8px;color:${statusColor};font-weight:bold;">${escapeHtml(a.status)}</td>
                <td style="padding:8px;font-size:12px;color:#888;">${escapeHtml(a.registered_at || '-')}</td>
                <td style="padding:8px;">${actions}</td>
            </tr>`;
        });

        res.send(`<html>
        <head>
            <script>
                const CSRF_TOKEN = '${csrfToken}';
                const ADMIN_SECRET = '${adminSecret}';
                function filterCrops(q) {
                    const term = q.toLowerCase();
                    document.querySelectorAll('#price-inputs [data-crop]').forEach(el => {
                        el.style.display = el.dataset.crop.includes(term) ? '' : 'none';
                    });
                }
                function updateStatus(id, newStatus) {
                    fetch('/update-status', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ id: id, status: newStatus, _csrf: CSRF_TOKEN })
                    }).then(() => window.location.reload());
                }
                function agentAction(phone, newStatus) {
                    fetch('/api/admin/agents/' + encodeURIComponent(phone) + '/status', {
                        method: 'PATCH',
                        headers: {'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET},
                        body: JSON.stringify({ status: newStatus })
                    }).then(() => window.location.reload());
                }
            </script>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 40px; background: #f4f7f6;">
            <div style="max-width: 1100px; margin: auto;">

                <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); margin-bottom: 20px;">
                    <h2 style="color: #2980b9; margin-top:0;">📈 Set Daily Market Prices (UGX)</h2>
                    <input type="search" placeholder="Search crop..." oninput="filterCrops(this.value)" style="padding:8px 12px; width:220px; border:1px solid #ccc; border-radius:4px; margin-bottom:12px; font-size:14px;">
                    <form action="/update-prices" method="POST" style="display: flex; gap: 15px; align-items: flex-end; flex-wrap: wrap;">
                        <input type="hidden" name="_csrf" value="${csrfToken}">
                        <div id="price-inputs" style="display:flex; gap:15px; flex-wrap:wrap; width:100%;">${priceInputs}</div>
                        <button type="submit" style="background: #2980b9; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; margin-bottom: 10px;">Broadcast Prices</button>
                    </form>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
                    <form action="/add-crop" method="POST" style="display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap;">
                        <input type="hidden" name="_csrf" value="${csrfToken}">
                        <div><label style="font-size: 12px; color: #666; font-weight: bold;">New Crop Name</label><br>
                        <input type="text" name="crop" required placeholder="e.g. Vanilla" style="padding:8px; width:140px; border:1px solid #ccc; border-radius:4px;"></div>
                        <div><label style="font-size: 12px; color: #666; font-weight: bold;">Price (UGX)</label><br>
                        <input type="text" name="price" required placeholder="e.g. 50000" style="padding:8px; width:100px; border:1px solid #ccc; border-radius:4px;"></div>
                        <div><label style="font-size: 12px; color: #666; font-weight: bold;">Unit</label><br>
                        <select name="unit" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
                            <option value="per kg">per kg</option>
                            <option value="per bunch">per bunch</option>
                            <option value="per head">per head</option>
                            <option value="per piece">per piece</option>
                            <option value="per stick">per stick</option>
                            <option value="per bag">per bag</option>
                            <option value="per tin">per tin</option>
                            <option value="per basin">per basin</option>
                        </select></div>
                        <button type="submit" style="background: #27ae60; color: white; padding: 10px 16px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">+ Add Crop</button>
                    </form>
                </div>

                <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); margin-bottom: 20px;">
                    <h2 style="color: #8e44ad; margin-top:0;">👤 Agent Management (${agentsList.length} registered)</h2>
                    ${agentsList.length === 0 ? '<p style="color:#888;">No agents registered yet.</p>' : `
                    <table style="width: 100%; text-align: left; border-collapse: collapse;">
                        <tr style="background: #8e44ad; color: white;">
                            <th style="padding: 8px;">Phone</th><th style="padding: 8px;">Name</th>
                            <th style="padding: 8px;">District</th><th style="padding: 8px;">Status</th>
                            <th style="padding: 8px;">Registered</th><th style="padding: 8px;">Actions</th>
                        </tr>
                        ${agentRows}
                    </table>`}
                </div>

                <div style="background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                    <h2 style="color: #2c3e50; margin-top:0;">🌾 Agri-Bridge Command Center</h2>
                    <table style="width: 100%; text-align: left; border-collapse: collapse; margin-top: 20px;">
                        <tr style="background: #2c3e50; color: white;">
                            <th style="padding: 12px;">Date & Time</th><th style="padding: 12px;">Phone</th>
                            <th style="padding: 12px;">Details</th><th style="padding: 12px;">Parish</th>
                            <th style="padding: 12px;">Status</th><th style="padding: 12px;">Actions</th>
                        </tr>
                        ${rows}
                    </table>
                </div>
            </div>
        </body></html>`);
    });

    // API endpoint for dashboard buttons
    app.post('/update-status', async (req, res) => {
        if (!validateCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
        const { id, status } = req.body;
        const listing = getListing(id);
        updateListingStatus(id, status);

        if (listing) {
            const msg = status === '[APPROVED]'
                ? `Agri-Bridge: Your listing "${listing.detail}" has been approved and is now live.`
                : `Agri-Bridge: Your listing "${listing.detail}" was not approved. Contact us for details.`;
            await sendSms(sms, listing.phone, msg);
        }

        res.json({ success: true });
    });

    // API endpoint for updating prices dynamically
    app.post('/update-prices', (req, res) => {
        if (!validateCsrf(req)) return res.status(403).send('Invalid CSRF token');
        const { _csrf, ...priceData } = req.body;
        setPrices(priceData);
        res.redirect('/');
    });

    // Add a new crop to the price list
    app.post('/add-crop', (req, res) => {
        if (!validateCsrf(req)) return res.status(403).send('Invalid CSRF token');
        const { crop, price, unit } = req.body;
        if (!crop || !price) return res.redirect('/');
        const name = crop.trim().replace(/[<>"'&]/g, '');
        if (!name) return res.redirect('/');
        setPrices({ [name]: { price: price.trim(), unit: unit || 'per kg' } });
        res.redirect('/');
    });

    // Global error handler — never crash, always log
    app.use((err, req, res, _next) => {
        const phone = req.headers['x-phone'] || req.body?.phone || '';
        try { logInsert.run(new Date().toISOString(), req.method, req.path, phone, 500, 0, String(err.message || err).slice(0, 500), 'ERROR'); } catch (_) {}
        notify.error(`${req.method} ${req.path}`, err.message || err);
        console.error('[ERROR]', req.method, req.path, err);
        res.status(500).json({ error: 'Internal server error' });
    });

    return app;
}

// ==========================================
// STANDALONE ENTRY POINT
// ==========================================
if (require.main === module) {
    if (!process.env.ADMIN_SECRET) {
        console.warn('[SECURITY] ADMIN_SECRET is not set — admin endpoints will be inaccessible. Set it in env vars.');
    }

    const dataDir = '/data';
    const defaultDb = require('fs').existsSync(dataDir) ? path.join(dataDir, 'agribis.db') : path.join(__dirname, '..', 'agribis.db');
    const dbPath = process.env.DB_PATH || defaultDb;
    const db = createDb(dbPath);

    migrateJSON(db, path.join(__dirname, '..', 'ledger.json'), (db, data) => {
        if (!Array.isArray(data)) return;
        const insert = db.prepare('INSERT OR IGNORE INTO listings (id,time,phone,detail,location,type,status) VALUES (?,?,?,?,?,?,?)');
        const insertMany = db.transaction((rows) => { for (const r of rows) insert.run(r.id, r.time, r.phone, r.detail, r.location, r.type, r.status); });
        insertMany(data);
    });

    migrateJSON(db, path.join(__dirname, '..', 'profiles.json'), (db, data) => {
        if (typeof data !== 'object') return;
        const insert = db.prepare('INSERT OR IGNORE INTO profiles (phone,name,parish,district) VALUES (?,?,?,?)');
        const insertMany = db.transaction((entries) => { for (const [phone, p] of entries) insert.run(phone, p.name, p.parish, p.district); });
        insertMany(Object.entries(data));
    });

    migrateJSON(db, path.join(__dirname, '..', 'prices.json'), (db, data) => {
        if (typeof data !== 'object') return;
        const insert = db.prepare('INSERT OR IGNORE INTO prices (crop,price) VALUES (?,?)');
        const insertMany = db.transaction((entries) => { for (const [crop, price] of entries) insert.run(crop, price); });
        insertMany(Object.entries(data));
    });

    seedPrices(db);

    // Auto-seed demo data on first boot if SEED_DEMO=true
    if (process.env.SEED_DEMO === 'true') {
        const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get().c;
        if (agentCount === 0) {
            try {
                require('../scripts/seed');
            } catch (e) {
                console.warn('[SEED] Auto-seed failed:', e.message);
            }
        }
    }

    const app = createApp(db, createSms());

    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => console.log(`Agri-Bridge Control Room Live on Port ${PORT}`));

    function shutdown() {
        console.log('Shutting down gracefully...');
        server.close(() => {
            db.close();
            process.exit(0);
        });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = { createApp, createDb, createHelpers, seedPrices, hashPin };
