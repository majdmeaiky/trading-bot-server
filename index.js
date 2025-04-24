const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();
const crypto = require('crypto');
//const fs = require('fs');
//const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);


//const TIMESTAMP_FILE = path.join(__dirname, 'entryTimestamps.json');
const app = express();
app.use(bodyParser.json());

const BASE = 'https://fapi.binance.com';

function signQuery(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Read timestamps from file
async function loadTimestampFromSupabase(symbol) {
    const { data, error } = await supabase
        .from('orders')
        .select('timeStamp')
        .eq('symbol', symbol)
        .single();

    if (error) {
        console.error("❌ Failed to load timestamp:", error);
        return null;
    }
    return data;
}


// Write timestamps to file
async function saveTimestampToSupabase(symbol) {
    const { data, error } = await supabase
        .from('orders')
        .upsert([{ symbol, timeStamp: Date.now() }], { onConflict: ['symbol'] });

    if (error) {
        console.error("❌ Failed to save timestamp:", error);
    } else {
        console.log("✅ Timestamp saved to Supabase:", data);
    }
}



app.post('/webhook', async (req, res) => {
    //let entryTimestamps = loadTimestamps();
    //console.log('json',entryTimestamps );

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
        await axios.post(leverageFullURL, null, {
            headers: { 'X-MBX-APIKEY': key }
        });
        const lastEntryTime = await loadTimestampFromSupabase(symbol);
        await saveTimestampToSupabase(symbol);

        //entryTimestamps[symbol] = Date.now();
        //saveTimestamps(entryTimestamps);
        console.log('success',lastEntryTime );


    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).send('❌ Order Failed');
    }
});

app.get('/', (req, res) => {
    res.status(200).send("✅ Server is alive.");
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
