const express = require('express');

const router = express.Router();

router.get('/:room', (req, res) => {
    res.render('room', { roomId: req.params.room });
});

module.exports = router;


