#!/usr/bin/env node
/**
 * Agri-Bridge USSD Simulator
 *
 * Mimics the Africa's Talking USSD gateway against the local server.
 * Sends the same POST body AT would send: { sessionId, phoneNumber, text, serviceCode }
 *
 * Usage:
 *   node scripts/ussd-sim.js                          # interactive mode
 *   node scripts/ussd-sim.js --demo farmer            # scripted farmer demo
 *   node scripts/ussd-sim.js --demo buyer             # scripted buyer demo
 *   node scripts/ussd-sim.js --demo full              # full end-to-end demo
 *   node scripts/ussd-sim.js --phone +256700000001    # custom phone number
 *   node scripts/ussd-sim.js --port 3001              # custom port
 */

'use strict';

const http = require('http');
const readline = require('readline');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || '3000', 10);
const SERVICE_CODE = process.env.USSD_CODE || '*384*57#';

// Parse CLI args
const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) argMap[args[i].slice(2)] = args[i + 1] || true;
}

const PHONE    = argMap.phone || '+256700000001';
const DEMO_KEY = argMap.demo  || null;
const PORT_ARG = argMap.port  ? parseInt(argMap.port, 10) : PORT;

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    green:  '\x1b[32m',
    cyan:   '\x1b[36m',
    yellow: '\x1b[33m',
    grey:   '\x1b[90m',
    red:    '\x1b[31m',
    bg:     '\x1b[42m\x1b[30m',
};

function print(msg) { process.stdout.write(msg + '\n'); }
function sep()      { print(C.grey + '─'.repeat(50) + C.reset); }

// ── AT payload POST ───────────────────────────────────────────────────────────
function ussdPost(sessionId, phoneNumber, text) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            sessionId,
            phoneNumber,
            serviceCode: SERVICE_CODE,
            text,
            networkCode: 'sandbox',
        }).toString();

        const opts = {
            hostname: '127.0.0.1',
            port:     PORT_ARG,
            path:     '/ussd',
            method:   'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = http.request(opts, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end',  () => resolve(data));
        });
        req.on('error', err => reject(err));
        req.write(body);
        req.end();
    });
}

// ── Render response ───────────────────────────────────────────────────────────
function renderResponse(raw) {
    const isCon = raw.startsWith('CON ');
    const isEnd = raw.startsWith('END ');
    const text  = isCon ? raw.slice(4) : isEnd ? raw.slice(4) : raw;
    const label = isCon ? `${C.green}${C.bold}[MENU]${C.reset}` : `${C.yellow}${C.bold}[END]${C.reset}`;

    sep();
    print(`${label}`);
    print('');
    text.split('\n').forEach(line => print(`  ${C.cyan}${line}${C.reset}`));
    print('');
    return { isCon, isEnd, text };
}

// ── Interactive mode ──────────────────────────────────────────────────────────
async function runInteractive() {
    const sessionId = crypto.randomUUID();
    let inputText = '';

    print('');
    print(`${C.bg} Agri-Bridge USSD Simulator ${C.reset}`);
    print(`${C.grey}Phone: ${PHONE}  |  Service: ${SERVICE_CODE}  |  Server: localhost:${PORT_ARG}${C.reset}`);
    print(`${C.grey}Type input and press Enter. "q" or Ctrl+C to quit.${C.reset}`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Dial in — empty text = opening the USSD session
    try {
        const raw = await ussdPost(sessionId, PHONE, '');
        const { isCon } = renderResponse(raw);
        if (!isCon) { rl.close(); return; }
    } catch (e) {
        print(`${C.red}Connection refused. Is the server running on port ${PORT_ARG}?${C.reset}`);
        print(`${C.grey}Start with: npm start${C.reset}`);
        rl.close();
        return;
    }

    const prompt = () => rl.question(`${C.bold}Enter option: ${C.reset}`, async input => {
        input = input.trim();
        if (input === 'q' || input === 'quit') { print('Bye.'); rl.close(); return; }

        inputText = inputText ? `${inputText}*${input}` : input;

        try {
            const raw = await ussdPost(sessionId, PHONE, inputText);
            const { isCon } = renderResponse(raw);
            if (isCon) prompt();
            else rl.close();
        } catch (e) {
            print(`${C.red}Error: ${e.message}${C.reset}`);
            rl.close();
        }
    });

    prompt();
}

// ── Scripted demo ─────────────────────────────────────────────────────────────
const DEMOS = {
    farmer: {
        label: 'Farmer registers and lists produce',
        phone: '+256770000001',
        steps: [
            { input: '',        note: 'Dial in — main menu' },
            { input: '1',       note: 'Select Farmer' },
            { input: 'Kato John-Kibibi-Mityana', note: 'Register: Name-Parish-District' },
            { input: '1',       note: 'List produce' },
            { input: 'Matooke 50 bunches', note: 'Enter crop & quantity' },
        ],
    },
    buyer: {
        label: 'Buyer registers and browses village listings',
        phone: '+256780000002',
        steps: [
            { input: '',        note: 'Dial in — main menu' },
            { input: '3',       note: 'Select Buyer' },
            { input: '2',       note: 'Register' },
            { input: 'Nakato Jane', note: 'Enter name' },
            { input: '1234',    note: 'Enter PIN' },
            { input: '1234',    note: 'Confirm PIN' },
        ],
    },
    prices: {
        label: 'Check today\'s market prices',
        phone: '+256790000003',
        steps: [
            { input: '',  note: 'Dial in — main menu' },
            { input: '4', note: 'Select Prices' },
        ],
    },
    full: {
        label: 'Full end-to-end: farmer lists → buyer registers → buyer browses',
        phone: '+256700000099',
        steps: [
            // Farmer sub-flow
            { input: '',        note: '── FARMER: Dial in' },
            { input: '1',       note: 'Select Farmer' },
            { input: 'Demo Farmer-Kibibi-Mityana', note: 'Register farmer' },
            { input: '1',       note: 'List produce' },
            { input: 'Maize 80kg', note: 'Enter crop & qty (auto-approved)' },
        ],
    },
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runDemo(key) {
    const demo = DEMOS[key];
    if (!demo) {
        print(`${C.red}Unknown demo "${key}". Available: ${Object.keys(DEMOS).join(', ')}${C.reset}`);
        process.exit(1);
    }

    print('');
    print(`${C.bg} Agri-Bridge USSD Simulator — Demo: ${demo.label} ${C.reset}`);
    print(`${C.grey}Phone: ${demo.phone}  |  Service: ${SERVICE_CODE}  |  Server: localhost:${PORT_ARG}${C.reset}`);
    print('');

    const sessionId = crypto.randomUUID();
    let inputText = '';

    for (const step of demo.steps) {
        if (step.note) print(`${C.grey}▶ ${step.note}${C.reset}`);

        if (step.input !== '') {
            inputText = inputText ? `${inputText}*${step.input}` : step.input;
        }

        let raw;
        try {
            raw = await ussdPost(sessionId, demo.phone, step.input === '' ? '' : inputText);
        } catch (e) {
            print(`${C.red}Connection refused. Is the server running on port ${PORT_ARG}?${C.reset}`);
            print(`${C.grey}Start with: npm start${C.reset}`);
            process.exit(1);
        }

        renderResponse(raw);
        await sleep(400); // Pause between steps for readability
    }

    print(`${C.green}${C.bold}Demo complete.${C.reset}`);
    print(`${C.grey}Check the admin dashboard at http://localhost:${PORT_ARG}/  to see the result.${C.reset}`);
    print('');
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (DEMO_KEY) {
    runDemo(DEMO_KEY).catch(e => { print(`${C.red}${e.message}${C.reset}`); process.exit(1); });
} else {
    runInteractive().catch(e => { print(`${C.red}${e.message}${C.reset}`); process.exit(1); });
}
