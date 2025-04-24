const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TIMESTAMP_FILE = path.join(__dirname, 'entryTimestamps.json');
const app = express();
app.use(bodyParser.json());

const BASE = 'https://fapi.binance.com';

function signQuery(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Read timestamps from file
function loadTimestamps() {
    try {
        const data = fs.readFileSync('TIMESTAMP_FILE', 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("❌ Failed to load timestamps:", err);
        return {};
    }
}

// Write timestamps to file
function saveTimestamps(data) {
    try {
        fs.writeFileSync(TIMESTAMP_FILE, JSON.stringify(data));
    } catch (err) {
        console.error("❌ Failed to save timestamps:", err);
    }
}


app.post('/webhook', async (req, res) => {
    let entryTimestamps = loadTimestamps();
    console.log('json',entryTimestamps );

    const { symbol, side, qty, leverage, sl, tp, close } = req.body;

    const key = process.env.BINANCE_KEY;
    const secret = process.env.BINANCE_SECRET;

    try {
        console.log("start");
        // ✅ Check if there is an active position
        const activeOrderParams = `symbol=${symbol}&timestamp=${Date.now()}`;
        const signatureAcivenOrder = signQuery(activeOrderParams, secret);
        const activeOrderFullURL = `${BASE}/fapi/v2/positionRisk?${activeOrderParams}&signature=${signatureAcivenOrder}`;
        const positionRes = await axios.get(activeOrderFullURL, {
            headers: { 'X-MBX-APIKEY': key }
        });
        const allPositions = positionRes.data;
        const position = allPositions.find(p => Math.abs(Number(p.positionAmt)) > 0);

        console.log("active positions:" , position);
  

        if (close && position != null) {
            const closeSide = Number(position.positionAmt) > 0 ? 'SELL' : 'BUY';

            const closeParams = `symbol=${symbol}&side=${closeSide}&type=MARKET&closePosition=true&timestamp=${Date.now()}`;
            const closeSignature = signQuery(closeParams, secret);
            const closeURL = `${BASE}/fapi/v1/order?${closeParams}&signature=${closeSignature}`;

            await axios.post(closeURL, null, {
                headers: { 'X-MBX-APIKEY': key }
            });

            return res.status(200).send("✅ Position closed.");
        }



        if (position && Math.abs(Number(position.positionAmt)) > 0) {
            return res.status(200).send("Trade skipped: already active position.");
        }

        console.log("✅ No open orders. Proceeding with trade...");

        // Set Leverage
        const leverageParams = `symbol=${symbol}&leverage=${leverage}&timestamp=${Date.now()}`;
        const signatureLeverage = signQuery(leverageParams, secret);
        const leverageFullURL = `${BASE}/fapi/v1/leverage?${leverageParams}&signature=${signatureLeverage}`;
        console.log('json: ', leverageFullURL);
        await axios.post(leverageFullURL, null, {
            headers: { 'X-MBX-APIKEY': key }
        });
        entryTimestamps[symbol] = Date.now();
        saveTimestamps(entryTimestamps);
        console.log('success',entryTimestamps );


        // Market Order
        const orderParams = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
        const signatureOrder = signQuery(orderParams, secret);
        const orderFullURL = `${BASE}/fapi/v1/order?${orderParams}&signature=${signatureOrder}`;
        console.log('json: ', orderFullURL)
        await axios.post(orderFullURL, null, {
            headers: { 'X-MBX-APIKEY': key }
        });
       

        // TP Order
        const tpSide = side === 'BUY' ? 'SELL' : 'BUY';
        const tpParams = `symbol=${symbol}&side=${tpSide}&type=TAKE_PROFIT_MARKET&stopPrice=${tp}&closePosition=true&timeInForce=GTC&timestamp=${Date.now()}`;
        const tpSignature = signQuery(tpParams, secret);
        const tpFullURL = `${BASE}/fapi/v1/order?${tpParams}&signature=${tpSignature}`;

        await axios.post(tpFullURL, null, {
            headers: { 'X-MBX-APIKEY': key }
        });

        // SL Order
        const slSide = side === 'BUY' ? 'SELL' : 'BUY';
        const slParams = `symbol=${symbol}&side=${slSide}&type=STOP_MARKET&stopPrice=${sl}&closePosition=true&timeInForce=GTC&timestamp=${Date.now()}`;
        const slSignature = signQuery(slParams, secret);
        const slFullURL = `${BASE}/fapi/v1/order?${slParams}&signature=${slSignature}`;

        await axios.post(slFullURL, null, {
            headers: { 'X-MBX-APIKEY': key }
        });



        res.status(200).send('✅ Order Executed');
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).send('❌ Order Failed');
    }
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
