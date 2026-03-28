const { Router } = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// ==========================================
// IN-MEMORY RATE LIMITER
// ==========================================
function createRateLimiter() {
    const buckets = new Map(); // key -> { count, resetAt }

    // Cleanup expired entries every 5 minutes
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of buckets) {
            if (now > bucket.resetAt) buckets.delete(key);
        }
    }, 5 * 60 * 1000);
    if (cleanup.unref) cleanup.unref(); // don't keep process alive

    return {
        // Returns true if allowed, false if rate-limited
        check(key, maxRequests, windowMs) {
            const now = Date.now();
            const bucket = buckets.get(key);
            if (!bucket || now > bucket.resetAt) {
                buckets.set(key, { count: 1, resetAt: now + windowMs });
                return true;
            }
            bucket.count++;
            return bucket.count <= maxRequests;
        },
        // Express middleware factory
        middleware(keyFn, maxRequests, windowMs) {
            return (req, res, next) => {
                const key = typeof keyFn === 'function' ? keyFn(req) : (req.ip || 'unknown');
                if (!this.check(key, maxRequests, windowMs)) {
                    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
                }
                next();
            };
        },
        _buckets: buckets // exposed for testing
    };
}

function createApiRouter(db, sms, sendSms, helpers, uploadsDir, opts) {
    const ADMIN_SECRET = opts?.adminSecret || process.env.ADMIN_SECRET;
    const isSandbox = (opts?.sandbox !== undefined) ? opts.sandbox : process.env.AT_USERNAME === 'sandbox';
    const router = Router();
    const {
        getProfile, saveProfile, addListing,
        getListing, getAllListings, getApprovedListings,
        updateListingStatus, setListingVideo, setVerification, getVerification,
        addFeedback, getFarmerReputation, getFarmerTrustLabel,
        getAgentRecord, isAgentSuspended, addCommission, getAgentCommissions,
        getPrices, setPrices,
        registerAgent, authenticateAgent, getAgent, setAgentStatus, getAllAgents,
        registerBuyer, authenticateBuyer,
        setProfilePin, authenticateProfile,
        generateOtp, storeOtp, verifyOtp
    } = helpers;

    // Rate limiter — use injected instance for testing, or create fresh
    const limiter = (opts && opts.limiter) || createRateLimiter();

    function extractCredentials(req) {
        return {
            phone: req.headers['x-phone'] || req.query.phone,
            pin:   req.headers['x-pin']   || req.query.pin
        };
    }

    // Rate limit configs
    const authLimit   = limiter.middleware(req => `auth:${req.headers['x-phone'] || req.body?.phone || req.query?.phone || req.ip}`, 5, 15 * 60 * 1000);  // 5 per 15min
    const regLimit    = limiter.middleware(req => `reg:${req.ip}`, 3, 60 * 60 * 1000);    // 3 per hour
    const listLimit   = limiter.middleware(req => `list:${req.body?.phone || req.ip}`, 10, 60 * 60 * 1000);   // 10 per hour
    const feedLimit   = limiter.middleware(req => `feed:${req.headers['x-phone'] || req.query?.phone || req.ip}`, 10, 60 * 60 * 1000); // 10 per hour
    const generalLimit = limiter.middleware(req => `gen:${req.ip}`, 60, 60 * 1000);       // 60 per min

    // Apply general rate limit to all API routes
    router.use(generalLimit);

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename:    (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.mp4';
            cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
        }
    });
    const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.3gp', '.m4v']);
    const upload = multer({
        storage,
        limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (file.mimetype.startsWith('video/') && ALLOWED_VIDEO_EXTS.has(ext)) cb(null, true);
            else cb(new Error('Only video files are allowed'));
        }
    });

    // ==========================================
    // AGENT REGISTRATION & LOGIN (OTP-verified)
    // ==========================================
    router.post('/agents/register', regLimit, async (req, res) => {
        const { phone, name, pin, district } = req.body;
        if (!phone || !name || !pin) return res.status(400).json({ error: 'phone, name, and pin required' });
        if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
        const existing = getAgent(phone);
        if (existing) return res.status(400).json({ error: 'Phone already registered as agent' });
        const code = generateOtp();
        storeOtp(phone, code, 'agent_register', { name, pin, district });
        await sendSms(sms, phone, `Agri-Bridge: Your verification code is ${code}. Valid for 10 minutes.`);
        const resp = { success: true, message: 'OTP sent. Verify to complete registration.' };
        if (isSandbox) resp.code = code;
        res.json(resp);
    });

    router.post('/agents/verify-otp', regLimit, (req, res) => {
        const { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
        const result = verifyOtp(phone, code, 'agent_register');
        if (result.error) return res.status(400).json({ error: result.error });
        const { name, pin, district } = result.payload;
        const reg = registerAgent(phone, name, pin, district);
        if (reg.error) return res.status(400).json({ error: reg.error });
        // Auto-approve agents in sandbox mode for testing
        if (isSandbox) setAgentStatus(phone, 'active');
        const msg = isSandbox ? 'Registered and auto-approved (sandbox). You can log in now.' : 'Registered! Pending admin approval.';
        res.json({ success: true, message: msg });
    });

    router.post('/agents/login', authLimit, (req, res) => {
        const { phone, pin } = req.body;
        if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
        // In sandbox mode, auto-activate pending agents on login
        if (isSandbox) {
            const agent = getAgent(phone);
            if (agent && agent.status === 'pending') {
                setAgentStatus(phone, 'active');
            }
        }
        const result = authenticateAgent(phone, pin);
        if (result.error) return res.status(403).json({ error: result.error });
        res.json({ success: true, agent: { phone: result.agent.phone, name: result.agent.name, district: result.agent.district, status: result.agent.status } });
    });

    // ==========================================
    // BUYER REGISTRATION & LOGIN (OTP-verified)
    // ==========================================
    router.post('/buyers/register', regLimit, async (req, res) => {
        const { phone, name, pin } = req.body;
        if (!phone || !name || !pin) return res.status(400).json({ error: 'phone, name, and pin required' });
        if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
        const existing = helpers.getBuyer(phone);
        if (existing) return res.status(400).json({ error: 'Phone already registered' });
        const code = generateOtp();
        storeOtp(phone, code, 'buyer_register', { name, pin });
        await sendSms(sms, phone, `Agri-Bridge: Your verification code is ${code}. Valid for 10 minutes.`);
        const resp = { success: true, message: 'OTP sent. Verify to complete registration.' };
        if (isSandbox) resp.code = code;
        res.json(resp);
    });

    router.post('/buyers/verify-otp', regLimit, (req, res) => {
        const { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
        const result = verifyOtp(phone, code, 'buyer_register');
        if (result.error) return res.status(400).json({ error: result.error });
        const { name, pin } = result.payload;
        const reg = registerBuyer(phone, name, pin);
        if (reg.error) return res.status(400).json({ error: reg.error });
        res.json(reg);
    });

    router.post('/buyers/login', authLimit, (req, res) => {
        const { phone, pin } = req.body;
        if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
        const buyer = authenticateBuyer(phone, pin);
        if (buyer) return res.json({ success: true, buyer: { phone: buyer.phone, name: buyer.name } });
        // Fall back to farmer profile with PIN (unified identity)
        const farmer = authenticateProfile(phone, pin);
        if (farmer) return res.json({ success: true, buyer: { phone: farmer.phone, name: farmer.name } });
        return res.status(403).json({ error: 'Invalid credentials' });
    });

    // ==========================================
    // ADMIN — AGENT MANAGEMENT
    // ==========================================
    router.get('/admin/agents', (req, res) => {
        if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
        res.json(getAllAgents());
    });

    router.patch('/admin/agents/:phone/status', (req, res) => {
        if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
        const { status } = req.body;
        if (!['active', 'suspended', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const agent = getAgent(req.params.phone);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        setAgentStatus(req.params.phone, status);
        res.json({ success: true });
    });

    // ==========================================
    // LISTINGS
    // ==========================================
    router.get('/listings', (req, res) => {
        res.json(getAllListings());
    });

    // GET /api/listings/active?type=VILLAGE|CITY  (credentials via x-phone/x-pin headers or query params)
    // Accepts buyer OR farmer-with-PIN credentials (unified identity)
    router.get('/listings/active', (req, res) => {
        const type = (req.query.type || 'VILLAGE').toUpperCase();
        const crop = req.query.crop || null;
        const { phone, pin } = extractCredentials(req);
        if (phone && pin) {
            const buyer = authenticateBuyer(phone, pin);
            const farmer = !buyer ? authenticateProfile(phone, pin) : null;
            if (!buyer && !farmer) return res.status(403).json({ error: 'Invalid credentials' });
        }
        res.json(getApprovedListings(type, crop));
    });

    // POST /api/listings/farmer  { phone, detail, asking_price?, price_unit?, stock?, lat?, lng? }
    router.post('/listings/farmer', listLimit, async (req, res) => {
        const { phone, detail, asking_price, price_unit, stock, lat, lng } = req.body;
        if (!phone || !detail) return res.status(400).json({ error: 'phone and detail are required' });
        const profile = getProfile(phone);
        if (!profile) return res.status(404).json({ error: 'Profile not found. Please register first.' });
        const status = '[APPROVED]';
        const listing = {
            id: crypto.randomUUID(), time: new Date().toLocaleString(),
            phone, detail, location: profile.parish, type: 'VILLAGE', status,
            asking_price: asking_price ? parseInt(asking_price) : null,
            price_unit: price_unit || null,
            stock: stock || null,
            lat: lat ? parseFloat(lat) : null,
            lng: lng ? parseFloat(lng) : null
        };
        addListing(listing);

        // Dispatch claimable lead to nearby agents
        const nearbyAgents = helpers.getAgentNearFarmer(profile.district, phone);
        for (const agent of nearbyAgents) {
            const msg = `Agri-Bridge Lead: ${detail} in ${profile.parish}, ${profile.district}. Reply 1 to claim. Ref:${listing.id.slice(0, 8)}`;
            await sendSms(sms, agent.phone, msg);
        }

        res.json({ success: true, status, agents_notified: nearbyAgents.length });
    });

    // POST /api/listings/broker  { phone, detail, asking_price?, price_unit?, stock? }
    router.post('/listings/broker', listLimit, (req, res) => {
        const { phone, detail, asking_price, price_unit, stock } = req.body;
        if (!phone || !detail) return res.status(400).json({ error: 'phone and detail are required' });
        addListing({
            id: crypto.randomUUID(), time: new Date().toLocaleString(),
            phone, detail, location: 'City Market', type: 'CITY', status: '[APPROVED]',
            asking_price: asking_price ? parseInt(asking_price) : null,
            price_unit: price_unit || null,
            stock: stock || null
        });
        res.json({ success: true, status: '[APPROVED]' });
    });

    // PATCH /api/listings/:id/status  { status: '[APPROVED]' | '[REJECTED]' }
    router.patch('/listings/:id/status', async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;
        const allowed = ['[APPROVED]', '[REJECTED]'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        const listing = getListing(id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        updateListingStatus(id, status);
        const msg = status === '[APPROVED]'
            ? `Agri-Bridge: Your listing "${listing.detail}" has been approved and is now live.`
            : `Agri-Bridge: Your listing "${listing.detail}" was not approved. Contact us for details.`;
        await sendSms(sms, listing.phone, msg);
        res.json({ success: true });
    });

    // ==========================================
    // PRICES
    // ==========================================
    router.get('/prices', (req, res) => {
        res.json(getPrices());
    });

    // GET /api/prices/ranges — price ranges from actual listings by market type
    router.get('/prices/ranges', (req, res) => {
        const ranges = helpers.getPriceRanges ? helpers.getPriceRanges() : [];
        res.json(ranges);
    });

    router.put('/prices', (req, res) => {
        setPrices(req.body);
        res.json({ success: true });
    });

    // ==========================================
    // PROFILES
    // ==========================================
    router.get('/profiles/:phone', (req, res) => {
        const profile = getProfile(req.params.phone);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });
        res.json(profile);
    });

    router.post('/profiles', regLimit, async (req, res) => {
        const { phone, name, parish, district, pin } = req.body;
        if (!phone || !name) return res.status(400).json({ error: 'phone and name are required' });
        if (pin && !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
        const code = generateOtp();
        storeOtp(phone, code, 'profile_register', { name, parish: parish || 'Unknown', district: district || 'Uganda', pin: pin || null });
        await sendSms(sms, phone, `Agri-Bridge: Your verification code is ${code}. Valid for 10 minutes.`);
        const resp = { success: true, message: 'OTP sent. Verify to complete profile creation.' };
        if (isSandbox) resp.code = code;
        res.json(resp);
    });

    router.post('/profiles/verify-otp', regLimit, (req, res) => {
        const { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
        const result = verifyOtp(phone, code, 'profile_register');
        if (result.error) return res.status(400).json({ error: result.error });
        const { name, parish, district, pin } = result.payload;
        saveProfile(phone, name, parish, district, pin);
        res.json({ success: true });
    });

    // Set PIN for existing farmer profile (e.g. USSD-registered farmer wants to use Pro App)
    router.post('/profiles/set-pin', authLimit, async (req, res) => {
        const { phone, pin } = req.body;
        if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
        if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
        const profile = getProfile(phone);
        if (!profile) return res.status(404).json({ error: 'No profile found. Register first.' });
        // Send OTP to verify phone ownership before setting PIN
        const code = generateOtp();
        storeOtp(phone, code, 'set_pin', { pin });
        await sendSms(sms, phone, `Agri-Bridge: Your verification code is ${code}. Valid for 10 minutes.`);
        const resp = { success: true, message: 'OTP sent. Verify to set your PIN.' };
        if (isSandbox) resp.code = code;
        res.json(resp);
    });

    router.post('/profiles/verify-pin-otp', authLimit, (req, res) => {
        const { phone, code } = req.body;
        if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
        const result = verifyOtp(phone, code, 'set_pin');
        if (result.error) return res.status(400).json({ error: result.error });
        setProfilePin(phone, result.payload.pin);
        res.json({ success: true, message: 'PIN set. You can now log in.' });
    });

    // Farmer login (for Pro App — works for both USSD and Pro App registered farmers)
    router.post('/profiles/login', authLimit, (req, res) => {
        const { phone, pin } = req.body;
        if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
        const profile = getProfile(phone);
        if (!profile) return res.status(403).json({ error: 'No profile found. Register first.' });
        if (!profile.pin_hash) return res.status(403).json({ error: 'No PIN set. Use Set PIN first.', needsPin: true });
        const authed = authenticateProfile(phone, pin);
        if (!authed) return res.status(403).json({ error: 'Wrong PIN.' });
        res.json({ success: true, profile: { phone: authed.phone, name: authed.name, parish: authed.parish, district: authed.district } });
    });

    // ==========================================
    // REPUTATION & FEEDBACK
    // ==========================================
    router.get('/reputation/:phone', (req, res) => {
        const rep = getFarmerReputation(req.params.phone);
        const label = getFarmerTrustLabel(req.params.phone);
        res.json({ ...rep, label });
    });

    router.post('/feedback', feedLimit, (req, res) => {
        // Authenticate buyer or farmer-with-PIN — phone comes from auth, not body (prevents spoofing)
        const { phone, pin } = extractCredentials(req);
        const buyer = authenticateBuyer(phone, pin) || authenticateProfile(phone, pin);
        if (!buyer) return res.status(403).json({ error: 'Invalid buyer credentials' });
        const buyerPhone = buyer.phone;

        const { listing_id, farmer_phone, rating } = req.body;
        if (!listing_id) return res.status(400).json({ error: 'listing_id required — rate a specific listing' });
        if (!farmer_phone || !rating) return res.status(400).json({ error: 'farmer_phone, rating required' });
        if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
        const result = addFeedback(listing_id, farmer_phone, buyerPhone, rating, req.body.comment || '');
        if (result.error) return res.status(400).json({ error: result.error });
        const rep = getFarmerReputation(farmer_phone);
        res.json({ success: true, reputation: rep });
    });

    // ==========================================
    // AGENT ENDPOINTS (Individual Auth)
    // ==========================================

    // GET /api/agent/listings  (credentials via x-phone/x-pin headers or query params)
    router.get('/agent/listings', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        const agentPhone = auth.agent.phone;
        const listings = getAllListings().map(l => ({
            ...l,
            _is_own: l.phone === agentPhone
        }));
        res.json(listings);
    });

    // POST /api/listings/:id/verify  (credentials via x-phone/x-pin headers or query params)
    router.post('/listings/:id/verify', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        const agentPhone = auth.agent.phone;

        const listing = getListing(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        const { grade, checklist, lat, lng, notes } = req.body;
        if (!grade || !checklist) return res.status(400).json({ error: 'grade and checklist required' });

        if (isAgentSuspended(agentPhone)) {
            return res.status(403).json({ error: 'Your agent account is suspended due to multiple buyer complaints. Contact admin.' });
        }

        if (agentPhone === listing.phone) {
            return res.status(403).json({ error: 'You cannot verify your own listing. Another agent must verify it.' });
        }

        const profile = getProfile(listing.phone);
        const locationMatch = (lat && lng && profile) ? true : false;
        setVerification(req.params.id, {
            agent_phone: agentPhone,
            grade, checklist, notes: notes || '',
            geo: (lat && lng) ? { lat, lng } : null,
            location_match: locationMatch,
            farmer_parish: profile?.parish || null,
            verified_at: new Date().toISOString()
        });
        addCommission(agentPhone, req.params.id, 5000);
        res.json({ success: true, commission_earned: 5000 });
    });

    // GET /api/listings/:id/verification
    router.get('/listings/:id/verification', (req, res) => {
        const listing = getListing(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        const v = getVerification(req.params.id);
        if (!v) return res.json({ verified: false });
        res.json({ verified: true, ...v });
    });

    // GET /api/agent/record  (credentials via x-phone/x-pin headers or query params)
    router.get('/agent/record', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        res.json(getAgentRecord(auth.agent.phone));
    });

    // GET /api/agent/commissions  (credentials via x-phone/x-pin headers)
    router.get('/agent/commissions', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        res.json(getAgentCommissions(auth.agent.phone));
    });

    // ==========================================
    // PURCHASE LEDGER & BATCHES
    // ==========================================

    // POST /api/agent/purchases — Log a farm-gate purchase
    router.post('/agent/purchases', listLimit, async (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        const agentPhone = auth.agent.phone;

        const { farmer_phone, listing_id, crop, quantity_kg, unit_price, price_unit, grade, moisture_level, transaction_time, lat, lng, notes } = req.body;
        if (!farmer_phone || !crop || !quantity_kg || !unit_price) {
            return res.status(400).json({ error: 'farmer_phone, crop, quantity_kg, and unit_price required' });
        }
        const qty = parseFloat(quantity_kg);
        const price = parseInt(unit_price);
        if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'quantity_kg must be a positive number' });
        if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'unit_price must be a positive number' });

        const farmer = helpers.getProfile(farmer_phone);
        if (!farmer) return res.status(404).json({ error: 'Farmer not registered. They must register first.' });

        const totalPrice = Math.round(qty * price);
        const purchase = {
            id: crypto.randomUUID(),
            agent_phone: agentPhone,
            farmer_phone,
            listing_id: listing_id || null,
            crop, quantity_kg: qty, unit_price: price, total_price: totalPrice,
            price_unit: price_unit || 'per kg',
            grade: grade || null,
            moisture_level: moisture_level ? parseFloat(moisture_level) : null,
            transaction_time: transaction_time || new Date().toISOString(),
            synced_at: new Date().toISOString(),
            lat: lat ? parseFloat(lat) : null,
            lng: lng ? parseFloat(lng) : null,
            notes: notes || null
        };
        helpers.logPurchase(purchase);

        // SMS receipt to farmer
        const agentName = auth.agent.name || agentPhone;
        const smsMsg = `Agri-Bridge: Agent ${agentName} purchased ${qty}kg ${crop} from you for ${totalPrice.toLocaleString()} UGX. Ref: ${purchase.id.slice(0, 8)}`;
        await sendSms(sms, farmer_phone, smsMsg);

        res.json({ success: true, purchase: { id: purchase.id, total_price: totalPrice } });
    });

    // GET /api/agent/purchases — Agent's purchase history
    router.get('/agent/purchases', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        const unbatched = req.query.unbatched === 'true';
        const purchases = unbatched
            ? helpers.getUnbatchedPurchases(auth.agent.phone)
            : helpers.getAgentPurchases(auth.agent.phone);
        res.json(purchases);
    });

    // POST /api/agent/batches — Create a batch from purchases
    router.post('/agent/batches', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        const agentPhone = auth.agent.phone;

        const { purchase_ids, crop } = req.body;
        if (!purchase_ids || !purchase_ids.length) return res.status(400).json({ error: 'purchase_ids required (array)' });
        if (!crop) return res.status(400).json({ error: 'crop required' });

        // Validate all purchases belong to this agent and are unbatched
        const purchases = [];
        for (const pid of purchase_ids) {
            const p = helpers.getPurchase(pid);
            if (!p) return res.status(404).json({ error: `Purchase ${pid} not found` });
            if (p.agent_phone !== agentPhone) return res.status(403).json({ error: `Purchase ${pid} belongs to another agent` });
            if (p.batch_id) return res.status(400).json({ error: `Purchase ${pid} already in a batch` });
            purchases.push(p);
        }

        const totalQty = purchases.reduce((s, p) => s + p.quantity_kg, 0);
        const moistures = purchases.filter(p => p.moisture_level != null).map(p => p.moisture_level);
        const avgMoisture = moistures.length ? Math.round((moistures.reduce((s, m) => s + m, 0) / moistures.length) * 10) / 10 : null;

        // Overall grade = lowest grade in the batch (C < B < A)
        const gradeOrder = { 'A': 3, 'B': 2, 'C': 1 };
        const grades = purchases.filter(p => p.grade).map(p => p.grade.toUpperCase());
        let overallGrade = null;
        if (grades.length) {
            const lowest = Math.min(...grades.map(g => gradeOrder[g] || 0));
            overallGrade = Object.entries(gradeOrder).find(([, v]) => v === lowest)?.[0] || grades[0];
        }

        // Generate batch code: district prefix + sequential
        const district = auth.agent.district || 'UG';
        const prefix = district.slice(0, 3).toUpperCase();
        const existing = helpers.getAgentBatches(agentPhone);
        const seq = String(existing.length + 1).padStart(3, '0');
        const batchCode = `${prefix}-${seq}`;

        const batch = {
            id: crypto.randomUUID(),
            agent_phone: agentPhone,
            batch_code: batchCode,
            crop,
            total_quantity_kg: totalQty,
            purchase_count: purchases.length,
            avg_moisture: avgMoisture,
            overall_grade: overallGrade,
            purchase_ids,
            created_at: new Date().toISOString()
        };
        helpers.createBatch(batch);
        res.json({ success: true, batch: { id: batch.id, batch_code: batchCode, total_quantity_kg: totalQty, overall_grade: overallGrade, avg_moisture: avgMoisture } });
    });

    // GET /api/agent/batches — Agent's batch list
    router.get('/agent/batches', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        res.json(helpers.getAgentBatches(auth.agent.phone));
    });

    // GET /api/batches/:id/trace — Traceability certificate for a batch
    router.get('/batches/:id/trace', (req, res) => {
        const batch = helpers.getBatch(req.params.id);
        if (!batch) return res.status(404).json({ error: 'Batch not found' });
        const purchases = helpers.getBatchTraceability(batch.id);
        res.json({
            batch_code: batch.batch_code,
            crop: batch.crop,
            total_quantity_kg: batch.total_quantity_kg,
            overall_grade: batch.overall_grade,
            avg_moisture: batch.avg_moisture,
            status: batch.status,
            created_at: batch.created_at,
            farmers: purchases.map(p => ({
                name: p.farmer_name || 'Unknown',
                parish: p.parish,
                district: p.district,
                quantity_kg: p.quantity_kg,
                grade: p.grade,
                moisture_level: p.moisture_level,
                purchased_at: p.transaction_time
            }))
        });
    });

    // POST /api/batches/:id/sell — Record batch sale
    router.post('/batches/:id/sell', (req, res) => {
        const { phone, pin } = extractCredentials(req);
        const auth = authenticateAgent(phone, pin);
        if (auth.error) return res.status(403).json({ error: auth.error });
        const batch = helpers.getBatch(req.params.id);
        if (!batch) return res.status(404).json({ error: 'Batch not found' });
        if (batch.agent_phone !== auth.agent.phone) return res.status(403).json({ error: 'Not your batch' });
        if (batch.status === 'sold') return res.status(400).json({ error: 'Batch already sold' });
        const { sale_price, buyer_phone } = req.body;
        if (!sale_price) return res.status(400).json({ error: 'sale_price required' });
        helpers.sellBatch(batch.id, parseInt(sale_price), buyer_phone);

        // Calculate and record commission
        const purchases = helpers.getBatchPurchases(batch.id);
        const costBasis = purchases.reduce((s, p) => s + p.total_price, 0);
        const margin = parseInt(sale_price) - costBasis;
        const platformFee = Math.max(0, Math.round(margin * 0.1)); // 10% of margin
        helpers.addCommission(auth.agent.phone, batch.id, platformFee > 0 ? margin - platformFee : 0);

        res.json({ success: true, cost_basis: costBasis, sale_price: parseInt(sale_price), margin, platform_fee: platformFee });
    });

    // POST /api/listings/:id/video  (credentials via x-phone/x-pin headers or query params)
    router.post('/listings/:id/video', (req, res) => {
        upload.single('video')(req, res, (err) => {
            if (err) return res.status(400).json({ error: err.message });
            const { phone, pin } = extractCredentials(req);
            const auth = authenticateAgent(phone, pin);
            if (auth.error) return res.status(403).json({ error: auth.error });
            const listing = getListing(req.params.id);
            if (!listing) return res.status(404).json({ error: 'Listing not found' });
            if (!req.file) return res.status(400).json({ error: 'No video file received' });
            setListingVideo(req.params.id, req.file.filename);
            res.json({ success: true, filename: req.file.filename });
        });
    });

    return router;
}

module.exports = { createApiRouter, createRateLimiter };
