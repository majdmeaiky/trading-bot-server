const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());


app.post('/webhook', (req, res) => {
    console.log("Webhook received:", req.body);
    res.status(200).send("OK");
  });
  