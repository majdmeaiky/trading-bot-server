const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();
const crypto = require('crypto');


const app = express();
app.use(bodyParser.json());

const BASE = 'https://fapi.binance.com';

function signQuery(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}


app.post('/webhook', async (req, res) => {
    const { symbol, side, qty, leverage, sl, tp } = req.body;

    const key = process.env.BINANCE_KEY;
    const secret = process.env.BINANCE_SECRET;

    try {
        // Set Leverage
        const leverageParams = `symbol=${symbol}&leverage=${leverage}&timestamp=${Date.now()}`;
        const signatureLeverage = signQuery(leverageParams, secret);
        const fullURL = `${BASE}/fapi/v1/leverage?${leverageParams}&signature=${signatureLeverage}`;
        console.log('json: ',fullURL)
        await axios.post(fullURL, null, {
          headers: { 'X-MBX-APIKEY': key }
        });


        // Market Order
        const orderParams = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${Date.now()}`;
        const signatureOrder = signQuery(orderParams, secret);
        const orderFullURL = `${BASE}/fapi/v1/order?${orderParams}&signature=${signatureOrder}`;
        console.log('json: ',orderFullURL)
        await axios.post(orderFullURL, null, {
          headers: { 'X-MBX-APIKEY': key }
        });

        // await axios.post(`${BASE}/fapi/v1/order`, null, {
        //     headers: { 'X-MBX-APIKEY': key },
        //     params: {
        //         symbol,
        //         side,
        //         type: 'MARKET',
        //         quantity: qty
        //     }
        // });

        // TP Order
        // await axios.post(`${BASE}/fapi/v1/order`, null, {
        //     headers: { 'X-MBX-APIKEY': key },
        //     params: {
        //         symbol,
        //         side: side === 'BUY' ? 'SELL' : 'BUY',
        //         type: 'TAKE_PROFIT_MARKET',
        //         stopPrice: tp,
        //         closePosition: true,
        //         timeInForce: 'GTC'
        //     }
        // });

        // SL Order
        // await axios.post(`${BASE}/fapi/v1/order`, null, {
        //     headers: { 'X-MBX-APIKEY': key },
        //     params: {
        //         symbol,
        //         side: side === 'BUY' ? 'SELL' : 'BUY',
        //         type: 'STOP_MARKET',
        //         stopPrice: sl,
        //         closePosition: true,
        //         timeInForce: 'GTC'
        //     }
        // });

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
