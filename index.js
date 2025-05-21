const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');


const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BASE = 'https://fapi.binance.com';

const activeTrades = {}; // Keeps all active trades in memory
let ws = null;           // Holds the current WebSocket connection
let reconnectTimeout = null;
let precisionMap = {};


const key = process.env.BINANCE_KEY;
const secret = process.env.BINANCE_SECRET;

app.use(bodyParser.json());
app.use(bodyParser.text({ type: "*/*" }));

// === Utility Functions ===

async function fetchPrecisionMap() {
    const exchangeInfoFullURL = `${BASE}/fapi/v1/exchangeInfo`;
    const res = await axios.get(exchangeInfoFullURL);
    for (const symbol of res.data.symbols) {
        const lot = symbol.filters.find(f => f.filterType === 'LOT_SIZE');
        const price = symbol.filters.find(f => f.filterType === 'PRICE_FILTER');

        precisionMap[symbol.symbol] = {
            qtyStep: parseFloat(lot.stepSize),
            priceTick: parseFloat(price.tickSize),
        };
    }
    console.log("✅ Binance precision map loaded");
}

function roundToStep(value, step) {
    const rounded = Math.floor(value / step) * step;
    const decimals = step.toString().split('.')[1]?.length || 0;
    return Number(rounded.toFixed(decimals));
}

async function reducePosition(symbol, side, qty) {
    try {
        const reduceSide = side === 'BUY' ? 'SELL' : 'BUY';

        const precision = precisionMap[symbol];
        const qtyRounded = roundToStep(qty, precision.qtyStep);

        const params = `symbol=${symbol}&side=${reduceSide}&type=MARKET&quantity=${qtyRounded}&reduceOnly=true&timestamp=${Date.now()}`;
        const signature = signQuery(params, secret);
        const url = `${BASE}/fapi/v1/order?${params}&signature=${signature}`;

        const res = await axios.post(url, null, {
            headers: { 'X-MBX-APIKEY': key },
        });

        console.log(`💰 Reduced position by ${qtyRounded} on ${symbol}`);
        return res.data;
    } catch (err) {
        console.error(`❌ Failed to reduce position for ${symbol}:`, err.response?.data || err.message);
    }
}

async function updateStopLoss(symbol, side, newSL) {
    try {
        const precision = precisionMap[symbol];
        const slRounded = roundToStep(newSL, precision.priceTick);
        const slSide = side === 'BUY' ? 'SELL' : 'BUY';

        // Step 1: Get all open orders for the symbol
        const getParams = `symbol=${symbol}&timestamp=${Date.now()}`;
        const getSig = signQuery(getParams, secret);
        const getURL = `${BASE}/fapi/v1/openOrders?${getParams}&signature=${getSig}`;
        const res = await axios.get(getURL, {
            headers: { 'X-MBX-APIKEY': key }
        });

        // Step 2: Find only the SL order (not TP)
        const slOrder = res.data.find(o =>
            o.type === 'STOP_MARKET' && o.closePosition === true
        );

        // Step 3: Cancel only the SL order
        if (slOrder) {
            try {
                const cancelParams = `symbol=${symbol}&orderId=${slOrder.orderId}&timestamp=${Date.now()}`;
                const cancelSig = signQuery(cancelParams, secret);
                const cancelURL = `${BASE}/fapi/v1/order?${cancelParams}&signature=${cancelSig}`;
                await axios.delete(cancelURL, {
                    headers: { 'X-MBX-APIKEY': key }
                });
                console.log(`❎ Canceled old SL order (ID: ${slOrder.orderId}) for ${symbol}`);
            }
            catch (cancelErr) {
                const msg = cancelErr.response?.data?.msg || cancelErr.message;
                console.warn(`⚠️ Cancel failed for ${symbol}: ${msg}`);
            }
        }
        else {
            console.warn(`⚠️ No SL found to cancel for ${symbol}`);
        }


        // Step 4: Place new SL
        const slParams = `symbol=${symbol}&side=${slSide}&type=STOP_MARKET&stopPrice=${slRounded}&closePosition=true&timeInForce=GTC&timestamp=${Date.now()}`;
        const slSig = signQuery(slParams, secret);
        const slURL = `${BASE}/fapi/v1/order?${slParams}&signature=${slSig}`;
        await axios.post(slURL, null, {
            headers: { 'X-MBX-APIKEY': key }
        });

        console.log(`🔄 New SL placed for ${symbol} at ${slRounded}`);
    } catch (err) {
        console.error(`❌ SL update failed for ${symbol}:`, err.response?.data || err.message);
    }
}

function signQuery(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}


// === Database Functions ===

async function saveTrade(symbol, side, qty, leverage, entryPrice, tp, sl, tp1, tp2) {
    const { error } = await supabase
        .from('orders')
        .upsert([{
            symbol,
            side,
            qty,
            leverage,
            entryPrice,
            tp,
            sl,
            tp1,
            tp1_hit: false,
            tp2,
            tp2_hit: false,
            sl_moved_half: false,
            sl_moved_be: false,
            sl_moved_1R: false,
            timeStamp: Date.now()
        }], { onConflict: ['symbol'] });

    if (error) console.error("❌ Failed to save trade:", error);
    else console.log("✅ Trade saved:", symbol);
}


function rebuildWebSocket() {
    if (ws) {
        ws.close();
        console.log("♻️ Rebuilding WebSocket with new symbol list...");
    }

    const symbols = Object.keys(activeTrades);
    if (symbols.length === 0) {
        console.log("🛑 No active trades to monitor. WebSocket not started.");
        return;
    }

    const streams = symbols.map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    const wsUrl = `wss://fstream.binance.com/stream?streams=${streams}`;

    ws = new WebSocket(wsUrl);

    ws.on('open', () => console.log(`📡 WebSocket connected for: ${symbols.join(', ')}`));

    ws.on('message', async (msg) => {
        try {

            const parsed = JSON.parse(msg);
            const symbol = parsed.data.s;
            const price = parseFloat(parsed.data.p);
            const trade = activeTrades[symbol];
            if (!trade) return;

            const isLong = trade.side === 'BUY';

            // === 0.5R SL MOVE (calc from tp1) ===
            const halfRLevel = isLong
                ? trade.entryPrice + (trade.tp1 - trade.entryPrice) * 0.5
                : trade.entryPrice - (trade.entryPrice - trade.tp1) * 0.5;

            if (!trade.sl_moved_half && (
                (isLong && price >= halfRLevel) ||
                (!isLong && price <= halfRLevel)
            )) {
                
                trade.sl_moved_half = true;
                await supabase.from('orders').update({ sl_moved_half: true }).eq('symbol', symbol);

                const halfRiskSL = isLong
                    ? trade.entryPrice - ((trade.entryPrice - trade.sl) * 0.4)
                    : trade.entryPrice + ((trade.sl - trade.entryPrice) * 0.4);

                try {
                    await updateStopLoss(symbol, trade.side, halfRiskSL);
                    trade.sl = halfRiskSL;

                    await supabase.from('orders').update({
                        sl: halfRiskSL
                    }).eq('symbol', symbol);
                }
                catch (err) {
                    console.error("0.5R SL move failed");
                }


                console.log(`🔒 SL moved to partial-risk (-0.2R) at ${halfRiskSL} for ${symbol}`);
            }


            // === TP1 HIT ===
            if (!trade.tp1_hit && ((isLong && price >= trade.tp1) || (!isLong && price <= trade.tp1))) {
                trade.tp1_hit = true;
                await supabase.from('orders').update({ tp1_hit: true }).eq('symbol', symbol);

                console.log(`🎯 TP1 HIT for ${symbol} at ${price}`);

                // Reduce 30%
                const reduceQty = trade.qty * 0.3;
                await reducePosition(symbol, trade.side, reduceQty);

                try {// Update SL on Binance
                    await updateStopLoss(symbol, trade.side, trade.entryPrice);
                    console.log(`🔐 SL moved to BE: ${trade.entryPrice}`);

                    trade.sl = trade.entryPrice;
                    trade.sl_moved_be = true;
                    trade.qty = trade.qty * 0.7;


                    await supabase.from('orders').update({
                        qty: trade.qty,
                        sl: trade.entryPrice,
                        sl_moved_be: true
                    }).eq('symbol', symbol);
                }
                catch (err) {
                    console.error("TP1 SL move to BE failed");
                }

            }

            // === TP2 HIT ===
            if (!trade.tp2_hit && ((isLong && price >= trade.tp2) || (!isLong && price <= trade.tp2))) {
                trade.tp2_hit = true;
                await supabase.from('orders').update({ tp2_hit: true }).eq('symbol', symbol);

                console.log(`🎯 TP2 HIT for ${symbol} at ${price}`);

                // Reduce 40%
                const reduceQty = trade.qty * 0.3;
                await reducePosition(symbol, trade.side, reduceQty);

                try {// Update SL on Binance
                    await updateStopLoss(symbol, trade.side, trade.tp1);
                    console.log(`🔐 SL moved to TP1 LEVEL: ${trade.tp1}`);


                    trade.sl = trade.tp1;
                    trade.sl_moved_1R = true;
                    trade.qty = trade.qty * 0.7;

                    await supabase.from('orders').update({
                        qty: trade.qty,
                        sl: trade.tp1,
                        sl_moved_1R: true
                    }).eq('symbol', symbol);

                    console.log(`🛡️ SL moved to breakeven`);
                }
                catch (err) {
                    console.error("TP2 SL move to TP1 failed");
                }
            }

            // === SL HIT ===
            if ((isLong && price <= trade.sl) || (!isLong && price >= trade.sl)) {
                console.log(`🛑 SL HIT for ${symbol} at ${price}`);
                await supabase.from('orders').delete().eq('symbol', symbol);
                delete activeTrades[symbol]; // ❌ Remove from memory
                console.log("♻️ Rebuilding WebSocket after SL...");
                rebuildWebSocket();
            }

        } catch (err) {
            console.error("❌ WebSocket message error:", err.message);
        }
    });

    ws.on('close', () => {
        console.log("🔌 WebSocket closed.");
    });

    ws.on('error', (err) => {
        console.error("❌ WebSocket error:", err.message);
        if (!reconnectTimeout) {
            reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null;
                rebuildWebSocket();
            }, 5000); // cooldown
        }
    });
}


// === Webhook Endpoint ===
app.post('/webhook', async (req, res) => {

    let body = req.body;
    try {
        if (typeof body === 'string') body = JSON.parse(body);
    } catch (e) {
        console.error("❌ JSON Parse Error:", e.message);
        return res.status(400).send("Bad JSON");
    }

    res.status(200).send("✅ Received"); // Send early response
    (async () => {

        const { symbol, side, qty, leverage, sl, tp, tp1, tp2, entryPrice } = body;
        console.log('✅ Webhook received for:', symbol);

        const precision = precisionMap[symbol];
        if (!precision) {
            console.error(`❌ Precision info not found for ${symbol}`);
            return;
        }

        try {
            const activeOrderParams = `symbol=${symbol}&timestamp=${Date.now()}`;
            const signatureActiveOrder = signQuery(activeOrderParams, secret);
            const activeOrderFullURL = `${BASE}/fapi/v2/positionRisk?${activeOrderParams}&signature=${signatureActiveOrder}`;
            const positionRes = await axios.get(activeOrderFullURL, {
                headers: { 'X-MBX-APIKEY': key }
            });

            const allPositions = positionRes.data;
            const position = allPositions.find(p => p.symbol === symbol && Math.abs(Number(p.positionAmt)) > 0);


            if (position) {
                console.log(`⚠️ Active position detected for ${symbol}. SKIPPING THIS TRADE!.`);
                return;
            }

            // Set leverage
            const leverageParams = `symbol=${symbol}&leverage=${leverage}&timestamp=${Date.now()}`;
            const signatureLeverage = signQuery(leverageParams, secret);
            const leverageFullURL = `${BASE}/fapi/v1/leverage?${leverageParams}&signature=${signatureLeverage}`;
            await axios.post(leverageFullURL, null, { headers: { 'X-MBX-APIKEY': key } });

            // Place Market Order
            const orderParams = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${roundToStep(qty, precision.qtyStep)}&timestamp=${Date.now()}`;
            const signatureOrder = signQuery(orderParams, secret);
            const orderFullURL = `${BASE}/fapi/v1/order?${orderParams}&signature=${signatureOrder}`;
            await axios.post(orderFullURL, null, { headers: { 'X-MBX-APIKEY': key } });

            // Set TP
            const tpSide = side === 'BUY' ? 'SELL' : 'BUY';
            const tpParams = `symbol=${symbol}&side=${tpSide}&type=TAKE_PROFIT_MARKET&stopPrice=${tp}&closePosition=true&timeInForce=GTC&timestamp=${Date.now()}`;
            const tpSignature = signQuery(tpParams, secret);
            const tpFullURL = `${BASE}/fapi/v1/order?${tpParams}&signature=${tpSignature}`;
            await axios.post(tpFullURL, null, { headers: { 'X-MBX-APIKEY': key } });

            // Set SL
            const slSide = side === 'BUY' ? 'SELL' : 'BUY';
            const slParams = `symbol=${symbol}&side=${slSide}&type=STOP_MARKET&stopPrice=${sl}&closePosition=true&timeInForce=GTC&timestamp=${Date.now()}`;
            const slSignature = signQuery(slParams, secret);
            const slFullURL = `${BASE}/fapi/v1/order?${slParams}&signature=${slSignature}`;
            await axios.post(slFullURL, null, { headers: { 'X-MBX-APIKEY': key } });

            console.log(`✅ New trade opened for ${symbol}`);

            await saveTrade(symbol, side, qty, leverage, entryPrice, tp, sl, tp1, tp2);
            activeTrades[symbol] = {
                symbol,
                side,
                qty,
                leverage,
                entryPrice,
                tp,
                sl,
                tp1,
                tp1_hit: false,
                tp2,
                tp2_hit: false,
                sl_moved_half: false,
                sl_moved_be: false,
                sl_moved_1R: false
            };

            rebuildWebSocket(); // 🔁 Update the WebSocket with the new trade

        } catch (err) {
            console.error(err.response?.data || err.message);
        }
    })();
});



// === Server Health Check ===
app.get('/', (req, res) => res.send('✅ Server is Running'));

app.listen(3000, async () => {
    await fetchPrecisionMap(); // 🔥 Load precision info first
    console.log('🚀 Server started on port 3000');

    const { data: trades, error } = await supabase.from('orders').select('*');
    if (error) {
        console.error("❌ Failed to load trades on startup:", error);
        return;
    }

    for (const trade of trades) {
        activeTrades[trade.symbol] = trade;
    }

    rebuildWebSocket(); // 🚀 Start WebSocket with loaded symbols
});
