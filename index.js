const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BASE = 'https://fapi.binance.com';
const BAR_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BARS = 30;
const MAX_DURATION_MS = BAR_DURATION_MS * MAX_BARS; // 12,000,000 ms

const key = process.env.BINANCE_KEY;
const secret = process.env.BINANCE_SECRET;

app.use(bodyParser.json());
app.use(bodyParser.text({ type: "*/*" }));

// === Utility Functions ===

function signQuery(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function isTradeTooOld(entryTimestamp) {
    return (Date.now() - entryTimestamp) >= MAX_DURATION_MS;
}

// === Database Functions ===

async function saveTrade(symbol, side, qty, leverage, sl, tp, entryPrice) {
    const { error } = await supabase
        .from('orders')
        .upsert([{
            symbol,
            side,
            qty,
            leverage,
            sl,
            tp,
            entryPrice,
            half_closed: false,
            timeStamp: Date.now()
        }], { onConflict: ['symbol'] });

    if (error) console.error("❌ Failed to save trade:", error);
    else console.log("✅ Trade saved:", symbol);
}

async function getTrade(symbol) {
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('symbol', symbol)
        .single();
    if (error) {
        console.error("❌ Failed to load trade:", error);
        return null;
    }
    return data;
}

async function deleteTrade(symbol) {
    const { error } = await supabase
        .from('orders')
        .delete()
        .eq('symbol', symbol);
    if (error) console.error("❌ Failed to delete trade:", error);
    else console.log("✅ Trade deleted:", symbol);
}

async function updateHalfClosed(symbol) {
    const { error } = await supabase
        .from('orders')
        .update({ half_closed: true })
        .eq('symbol', symbol);
    if (error) console.error("❌ Failed to update half close:", error);
    else console.log("✅ Trade updated to half-closed:", symbol);
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

        const { symbol, side, qty, leverage, sl, tp, close, entryPrice } = body;
        console.log('✅ Webhook received for:', symbol);

        try {
            const activeOrderParams = `symbol=${symbol}&timestamp=${Date.now()}`;
            const signatureActiveOrder = signQuery(activeOrderParams, secret);
            const activeOrderFullURL = `${BASE}/fapi/v2/positionRisk?${activeOrderParams}&signature=${signatureActiveOrder}`;
            const positionRes = await axios.get(activeOrderFullURL, {
                headers: { 'X-MBX-APIKEY': key }
            });

            const allPositions = positionRes.data;
            const position = allPositions.find(p => p.symbol === symbol && Math.abs(Number(p.positionAmt)) > 0);

            const currentTrade = await getTrade(symbol);
            console.log('close', close);
            console.log('position', position);
            console.log('currentTrade', currentTrade);

            if (close && position && currentTrade ) { //&& isTradeTooOld(currentTrade.timeStamp)
                // Close expired trade
                const closeSide = Number(position.positionAmt) > 0 ? 'SELL' : 'BUY';
                const closeParams = `symbol=${symbol}&side=${closeSide}&type=MARKET&quantity=${Math.abs(Number(position.positionAmt))}&timestamp=${Date.now()}`;
                const closeSignature = signQuery(closeParams, secret);
                const closeURL = `${BASE}/fapi/v1/order?${closeParams}&signature=${closeSignature}`;
                await axios.post(closeURL, null, { headers: { 'X-MBX-APIKEY': key } });
                await deleteTrade(symbol);
                console.log(`✅ Closed expired trade: ${symbol}`);
                return;
            }

            if (position) {
                console.log(`⚠️ Active position detected for ${symbol}. SKIPPING THIS TRADE!.`);
                return;
            }

            // No active position -> Place new
            await saveTrade(symbol, side, qty, leverage, sl, tp, entryPrice);

            // Set leverage
            const leverageParams = `symbol=${symbol}&leverage=${leverage}&timestamp=${Date.now()}`;
            const signatureLeverage = signQuery(leverageParams, secret);
            const leverageFullURL = `${BASE}/fapi/v1/leverage?${leverageParams}&signature=${signatureLeverage}`;
            await axios.post(leverageFullURL, null, { headers: { 'X-MBX-APIKEY': key } });

            // Place Market Order
            const orderParams = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
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
        } catch (err) {
            console.error(err.response?.data || err.message);
        }
    })();
});

// === Monitor Half TP and Move SL to BE ===
async function monitorTrades() {
    const { data: openTrades, error } = await supabase.from('orders').select('*');
    if (error || !openTrades) {
        console.error("❌ Failed to fetch open trades.");
        return;
    }

    for (const trade of openTrades) {
        try {
            const priceRes = await axios.get(`${BASE}/fapi/v1/ticker/price?symbol=${trade.symbol}`);
            const currentPrice = parseFloat(priceRes.data.price);

            const halfTP = trade.side === 'BUY'
                ? trade.entryPrice + (trade.tp - trade.entryPrice) * 0.5
                : trade.entryPrice - (trade.entryPrice - trade.tp) * 0.5;

            const hitHalfTP = (trade.side === 'BUY' && currentPrice >= halfTP) ||
                (trade.side === 'SELL' && currentPrice <= halfTP);

            if (!trade.half_closed && hitHalfTP) {
                console.log(`🎯 Half TP hit for ${trade.symbol}`);

                const partialQty = trade.qty / 2; // ⬅️ Close 50%

                // 1. Partial close 50% at market
                const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
                const closeParams = `symbol=${trade.symbol}&side=${closeSide}&type=MARKET&quantity=${partialQty}&timestamp=${Date.now()}`;
                const closeSignature = signQuery(closeParams, secret);
                const closeURL = `${BASE}/fapi/v1/order?${closeParams}&signature=${closeSignature}`;
                await axios.post(closeURL, null, { headers: { 'X-MBX-APIKEY': key } });
                console.log(`✅ 50% Position closed for ${trade.symbol}`);

                // 2. Move SL to BE for the rest
                const slSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
                const slParams = `symbol=${trade.symbol}&side=${slSide}&type=STOP_MARKET&stopPrice=${trade.entryPrice}&closePosition=true&timeInForce=GTC&timestamp=${Date.now()}`;
                const slSignature = signQuery(slParams, secret);
                const slURL = `${BASE}/fapi/v1/order?${slParams}&signature=${slSignature}`;
                await axios.post(slURL, null, { headers: { 'X-MBX-APIKEY': key } });
                console.log(`✅ SL moved to BE for ${trade.symbol}`);

                // Update trade status in DB
                await updateHalfClosed(trade.symbol);
            }
        } catch (err) {
            console.error(`❌ Error monitoring ${trade.symbol}:`, err.response?.data || err.message);
        }
    }
}


// Monitor every 15 seconds
//setInterval(monitorTrades, 15000);

// === Server Health Check ===
app.get('/', (req, res) => res.send('✅ Server is Running'));

app.listen(3000, () => console.log('🚀 Server started on port 3000'));
