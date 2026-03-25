const express = require('express');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

router.get('/', (req, res) => {
    res.render('main');
});

router.get('/new', (req, res) => {
    res.redirect(`/room/${uuidv4()}`);
});

module.exports = router;


