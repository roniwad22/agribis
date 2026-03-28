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
        res.json(reg);
    });

    router.post('/agents/login', authLimit, (req, res) => {
        const { phone, pin } = req.body;
        if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
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
        if (!buyer) return res.status(403).json({ error: 'Invalid credentials' });
        res.json({ success: true, buyer: { phone: buyer.phone, name: buyer.name } });
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
    router.get('/listings/active', (req, res) => {
        const type = (req.query.type || 'VILLAGE').toUpperCase();
        const { phone, pin } = extractCredentials(req);
        if (phone && pin) {
            const buyer = authenticateBuyer(phone, pin);
            if (!buyer) return res.status(403).json({ error: 'Invalid credentials' });
        }
        res.json(getApprovedListings(type));
    });

    // POST /api/listings/farmer  { phone, detail }
    router.post('/listings/farmer', listLimit, (req, res) => {
        const { phone, detail } = req.body;
        if (!phone || !detail) return res.status(400).json({ error: 'phone and detail are required' });
        const profile = getProfile(phone);
        if (!profile) return res.status(404).json({ error: 'Profile not found. Please register first.' });
        const status = '[APPROVED]';
        const listing = {
            id: crypto.randomUUID(), time: new Date().toLocaleString(),
            phone, detail, location: profile.parish, type: 'VILLAGE', status
        };
        addListing(listing);
        res.json({ success: true, status });
    });

    // POST /api/listings/broker  { phone, detail }
    router.post('/listings/broker', listLimit, (req, res) => {
        const { phone, detail } = req.body;
        if (!phone || !detail) return res.status(400).json({ error: 'phone and detail are required' });
        addListing({
            id: crypto.randomUUID(), time: new Date().toLocaleString(),
            phone, detail, location: 'City Market', type: 'CITY', status: '[APPROVED]'
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
        // Authenticate buyer — phone comes from auth, not body (prevents spoofing)
        const { phone, pin } = extractCredentials(req);
        const buyer = authenticateBuyer(phone, pin);
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
