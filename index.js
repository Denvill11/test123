require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

app.use(express.json());

const io = require('socket.io')(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

const { ExpressPeerServer } = require('peer');
const peerServer = ExpressPeerServer(server, {
  debug: process.env.NODE_ENV !== 'production'
});
app.use('/peerjs', peerServer);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'cumchatka-backend', port: PORT });
});

// Бек отвечает только за подключение к чату (signalling):
// - socket.io: user-connected / join-room
// - /peerjs: PeerJS signalling server
// - /api/new-room: создание roomId на бекe
app.get('/api/new-room', (req, res) => {
  res.json({ roomId: uuidv4() });
});

app.use((req, res) => {
  res.status(404).send('Not Found');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Internal Server Error');
});

const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('join-room', (roomId, userId, nick = '') => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.peerUserId = userId;

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    try {
      const list = Array.from(room.entries()).map(([id, n]) => ({ userId: id, nick: n || '' }));
      socket.emit('room-users', list);
    } catch (_) {}

    room.set(userId, nick || '');
    socket.to(roomId).emit('user-connected', { userId, nick });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const userId = socket.data.peerUserId;
    if (!roomId || userId == null || userId === '') return;

    socket.to(roomId).emit('user-disconnected', userId);
    try {
      const r = rooms.get(roomId);
      if (r) {
        r.delete(userId);
        if (r.size === 0) rooms.delete(roomId);
      }
    } catch (_) {}
  });
});

function start() {
  return new Promise((resolve, reject) => {
    server.listen(PORT, HOST, (err) => {
      if (err) return reject(err);
      console.log(`[backend] http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
      resolve();
    });
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { app, server, io, start, PORT, HOST };
