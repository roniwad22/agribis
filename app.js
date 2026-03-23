const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PREMIUM_PIN = "1234";

// ==========================================
// DATABASE SETUP
// ==========================================
const db = new Database('agribis.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    time TEXT,
    phone TEXT,
    detail TEXT,
    location TEXT,
    type TEXT,
    status TEXT
  );
  CREATE TABLE IF NOT EXISTS profiles (
    phone TEXT PRIMARY KEY,
    name TEXT,
    parish TEXT,
    district TEXT
  );
  CREATE TABLE IF NOT EXISTS prices (
    crop TEXT PRIMARY KEY,
    price TEXT
  );
`);

// Migrate existing JSON data on first run
function migrateJSON(file, migrateFunc) {
    if (!fs.existsSync(file)) return;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        migrateFunc(data);
        fs.renameSync(file, file + '.migrated');
        console.log(`Migrated ${file} to SQLite`);
    } catch (e) {
        console.log(`Migration skipped for ${file}: ${e.message}`);
    }
}

migrateJSON('ledger.json', (data) => {
    if (!Array.isArray(data)) return;
    const insert = db.prepare('INSERT OR IGNORE INTO listings (id,time,phone,detail,location,type,status) VALUES (?,?,?,?,?,?,?)');
    const insertMany = db.transaction((rows) => { for (const r of rows) insert.run(r.id, r.time, r.phone, r.detail, r.location, r.type, r.status); });
    insertMany(data);
});

migrateJSON('profiles.json', (data) => {
    if (typeof data !== 'object') return;
    const insert = db.prepare('INSERT OR IGNORE INTO profiles (phone,name,parish,district) VALUES (?,?,?,?)');
    const insertMany = db.transaction((entries) => { for (const [phone, p] of entries) insert.run(phone, p.name, p.parish, p.district); });
    insertMany(Object.entries(data));
});

migrateJSON('prices.json', (data) => {
    if (typeof data !== 'object') return;
    const insert = db.prepare('INSERT OR IGNORE INTO prices (crop,price) VALUES (?,?)');
    const insertMany = db.transaction((entries) => { for (const [crop, price] of entries) insert.run(crop, price); });
    insertMany(Object.entries(data));
});

// Seed default prices if table is empty
const priceCount = db.prepare('SELECT COUNT(*) as c FROM prices').get();
if (priceCount.c === 0) {
    const insert = db.prepare('INSERT INTO prices (crop,price) VALUES (?,?)');
    db.transaction(() => {
        insert.run('Maize', '1200');
        insert.run('Beans', '3500');
        insert.run('Matooke', '25000');
    })();
}

// ==========================================
// DB HELPER FUNCTIONS
// ==========================================
function getProfile(phone) {
    return db.prepare('SELECT * FROM profiles WHERE phone = ?').get(phone) || null;
}

function saveProfile(phone, name, parish, district) {
    db.prepare('INSERT OR REPLACE INTO profiles (phone,name,parish,district) VALUES (?,?,?,?)').run(phone, name, parish, district);
}

function addListing(listing) {
    db.prepare('INSERT INTO listings (id,time,phone,detail,location,type,status) VALUES (?,?,?,?,?,?,?)')
      .run(listing.id, listing.time, listing.phone, listing.detail, listing.location, listing.type, listing.status);
}

function getApprovedListings(type) {
    return db.prepare("SELECT * FROM listings WHERE type = ? AND status = '[APPROVED]' ORDER BY rowid DESC LIMIT 3").all(type);
}

function getAllListings() {
    return db.prepare('SELECT * FROM listings ORDER BY rowid DESC').all();
}

function updateListingStatus(id, status) {
    db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(status, id);
}

function getPrices() {
    const rows = db.prepare('SELECT crop, price FROM prices').all();
    return Object.fromEntries(rows.map(r => [r.crop, r.price]));
}

function setPrices(pricesObj) {
    const upsert = db.prepare('INSERT OR REPLACE INTO prices (crop,price) VALUES (?,?)');
    db.transaction(() => { for (const [crop, price] of Object.entries(pricesObj)) upsert.run(crop, price); })();
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

        // ==========================================
        // 0. MAIN MENU
        // ==========================================
        if (text === "") {
            response = `CON Welcome to Agri-Bridge
1. I am a Farmer (Village)
2. I am a Broker (City Vendor)
3. I am a Buyer
4. Check Market Prices`;
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
            const regData = parts[1].split('-');
            saveProfile(phoneNumber, regData[0]?.trim() || "Farmer", regData[1]?.trim() || "Unknown", regData[2]?.trim() || "Uganda");
            response = `CON Profile Created!
1. Start Listing Produce
0. Back`;
        }
        else if (text === "1*1" && profile) {
            response = `CON Listing from ${profile.parish}:
Enter Crop & Qty (e.g. Maize 50kg):`;
        }
        else if (text.startsWith("1*1*") && profile && parts.length === 3) {
            const detail = parts[2];
            let quantityMatch = detail.match(/\d+/);
            let quantityAmount = quantityMatch ? parseInt(quantityMatch[0]) : 999;

            // SMART TRIAGE: Auto-Approve if under 100
            let status = (quantityAmount < 100) ? "[APPROVED]" : "[PENDING]";

            addListing({
                id: Date.now().toString(),
                time: new Date().toLocaleString(),
                phone: phoneNumber,
                detail: detail,
                location: profile.parish,
                type: "VILLAGE",
                status: status
            });

            response = `END Success!
${status === "[APPROVED]" ? "Quantity is small, auto-approved. It is live!" : "Large quantity detected. We will call to verify."}`;
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
                id: Date.now().toString(),
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
        // 3. BUYER FLOW
        // ==========================================
        else if (text === "3") {
            response = `CON Select Market:
1. Farm Gate (Village Prices)
2. City Markets (Wholesale)`;
        }
        else if (text === "3*1" || text === "3*2") {
            const boardType = text === "3*1" ? "VILLAGE" : "CITY";
            response = `CON Accessing ${boardType} Database...
Enter your 4-digit PIN:`;
        }
        else if ((text.startsWith("3*1*") || text.startsWith("3*2*")) && parts.length === 3) {
            if (parts[2] === PREMIUM_PIN) {
                const boardType = text.includes("3*1*") ? "VILLAGE" : "CITY";
                const active = getApprovedListings(boardType);

                if (active.length === 0) {
                    response = `END No active listings right now.`;
                } else {
                    let listText = "END [VERIFIED]\n";
                    // PHASE 4: Show district only — never expose phone number to buyers
                    active.forEach(l => {
                        const prof = getProfile(l.phone);
                        const location = prof ? prof.district : l.location;
                        listText += `${l.detail} - ${location}\n`;
                    });
                    response = listText;
                }
            } else {
                response = `END Invalid PIN.`;
            }
        }

        // ==========================================
        // 4. PRICE CHECKER (FULLY DYNAMIC)
        // ==========================================
        else if (text === "4") {
            const prices = getPrices();
            let priceText = "END Today's Prices (UGX):\n";
            for (const [crop, price] of Object.entries(prices)) {
                priceText += `${crop}: ${price}\n`;
            }
            response = priceText;
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
    let rows = "";
    const listings = getAllListings();
    listings.forEach(l => {
        const isPending = l.status === '[PENDING]';
        const statusColor = isPending ? "#f39c12" : "#27ae60";

        const actionButtons = isPending
            ? `<button onclick="updateStatus('${l.id}', '[APPROVED]')" style="background:#27ae60; color:white; padding:5px 10px; border:none; border-radius:3px; cursor:pointer;">Approve</button>
               <button onclick="updateStatus('${l.id}', '[REJECTED]')" style="background:#e74c3c; color:white; padding:5px 10px; border:none; border-radius:3px; cursor:pointer; margin-left:5px;">Reject</button>`
            : `<span style="color:#7f8c8d; font-size: 0.9em;">Resolved</span>`;

        rows += `<tr style="background: white; border-bottom: 1px solid #ddd;">
            <td style="padding: 10px;">${l.time}</td>
            <td style="padding: 10px; font-weight: bold;">${l.phone}</td>
            <td style="padding: 10px;">${l.detail}</td>
            <td style="padding: 10px;">${l.location}</td>
            <td style="padding: 10px; color: ${statusColor}; font-weight: bold;">${l.status}</td>
            <td style="padding: 10px;">${actionButtons}</td>
        </tr>`;
    });

    const prices = getPrices();
    let priceInputs = Object.entries(prices).map(([crop, price]) => `
        <div style="margin-bottom: 10px;">
            <label style="font-size: 12px; color: #666; font-weight: bold;">${crop}</label><br>
            <input type="text" name="${crop}" value="${price}" style="padding:8px; width:120px; border:1px solid #ccc; border-radius:4px;">
        </div>
    `).join('');

    res.send(`<html>
    <head>
        <script>
            function updateStatus(id, newStatus) {
                fetch('/update-status', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ id: id, status: newStatus })
                }).then(() => window.location.reload());
            }
        </script>
    </head>
    <body style="font-family: Arial, sans-serif; padding: 40px; background: #f4f7f6;">
        <div style="max-width: 1100px; margin: auto;">

            <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); margin-bottom: 20px;">
                <h2 style="color: #2980b9; margin-top:0;">📈 Set Daily Market Prices (UGX)</h2>
                <form action="/update-prices" method="POST" style="display: flex; gap: 15px; align-items: flex-end; flex-wrap: wrap;">
                    ${priceInputs}
                    <button type="submit" style="background: #2980b9; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; margin-bottom: 10px;">Broadcast Prices</button>
                </form>
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
app.post('/update-status', (req, res) => {
    const { id, status } = req.body;
    updateListingStatus(id, status);
    res.json({ success: true });
});

// API endpoint for updating prices dynamically
app.post('/update-prices', (req, res) => {
    setPrices(req.body);
    res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agri-Bridge Control Room Live on Port ${PORT}`));
