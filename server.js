const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Default Admin Password (Change this if needed)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Track current active admin socket ID
let currentAdminId = null;

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // NTP Clock Sync
  socket.on('ntp_ping', (data) => {
    socket.emit('ntp_pong', { t0: data.t0, t1: Date.now() });
  });

  // Admin Login Verification
  socket.on('admin_login', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      currentAdminId = socket.id;
      socket.emit('login_result', { success: true });
      io.emit('admin_status', { hasAdmin: true });
    } else {
      socket.emit('login_result', { success: false, message: "Invalid Password" });
    }
  });

  // Transport Controls (Protected: Only Admin can emit)
  socket.on('play', (data) => {
    if (socket.id === currentAdminId) {
      socket.broadcast.emit('play', data);
    }
  });

  socket.on('pause', (data) => {
    if (socket.id === currentAdminId) {
      socket.broadcast.emit('pause', data);
    }
  });

  socket.on('seek', (data) => {
    if (socket.id === currentAdminId) {
      socket.broadcast.emit('seek', data);
    }
  });

  // Mixer Controls Sync (Protected: Only Admin can emit)
  socket.on('mixer_update', (data) => {
    if (socket.id === currentAdminId) {
      socket.broadcast.emit('mixer_update', data);
    }
  });

  socket.on('disconnect', () => {
    if (socket.id === currentAdminId) {
      currentAdminId = null;
      io.emit('admin_status', { hasAdmin: false });
    }
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sync Speaker Studio server running on port ${PORT}`);
});
