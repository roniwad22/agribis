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
        verification TEXT
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
            db.prepare('INSERT INTO listings (id,time,phone,detail,location,type,status) VALUES (?,?,?,?,?,?,?)')
              .run(listing.id, listing.time, listing.phone, listing.detail, listing.location, listing.type, listing.status);
        },
        getApprovedListings(type) {
            return db.prepare("SELECT * FROM listings WHERE type = ? AND status = '[APPROVED]' ORDER BY rowid DESC LIMIT 3").all(type);
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
        }
    };
    return helpers;
}

// ==========================================
// APP FACTORY
// ==========================================
function createApp(db, sms, opts) {
    const adminSecret = opts?.adminSecret || process.env.ADMIN_SECRET || '';

    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
    });
    app.use('/app', express.static(path.join(__dirname, '..', 'public')));

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
    app.use('/uploads', express.static(uploadsDir));

    const helpers = createHelpers(db);
    const { getProfile, saveProfile, addListing, getListing, getApprovedListings, getAllListings, updateListingStatus, getVerification, getPrices, getPricesMap, setPrices, getAllAgents, setAgentStatus } = helpers;

    app.use('/api', createApiRouter(db, sms, sendSms, helpers, uploadsDir, opts));

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
6. Rate a Seller`;
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
            // Submit listing — handles returning user (parts.length=3) and
            // newly-registered user in same session (parts.length=4)
            else if (parts[0] === "1" && profile &&
                     parts[parts.length - 2] === "1" &&
                     (parts.length === 3 || parts.length === 4)) {
                const detail = parts[parts.length - 1];
                let quantityMatch = detail.match(/\d+/);
                let quantityAmount = quantityMatch ? parseInt(quantityMatch[0]) : 999;

                // ALL listings go live immediately — agents verify, not gate
                const status = "[APPROVED]";
                const needsVerify = quantityAmount >= 100;

                addListing({
                    id: crypto.randomUUID(),
                    time: new Date().toLocaleString(),
                    phone: phoneNumber,
                    detail: detail,
                    location: profile.parish,
                    type: "VILLAGE",
                    status: status
                });

                response = `END Your listing is LIVE!
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
            else if (text.startsWith("2*1*") && parts.length === 3) {
                addListing({
                    id: crypto.randomUUID(),
                    time: new Date().toLocaleString(),
                    phone: phoneNumber,
                    detail: parts[2],
                    location: "City Market",
                    type: "CITY",
                    status: "[APPROVED]"
                });
                response = `END Success! City wholesale stock is live.`;
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

    return app;
}

// ==========================================
// STANDALONE ENTRY POINT
// ==========================================
if (require.main === module) {
    if (!process.env.ADMIN_SECRET) {
        console.warn('[SECURITY] ADMIN_SECRET is not set — admin endpoints will be inaccessible. Set it in env vars.');
    }

    const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'agribis.db');
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
