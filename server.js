const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const io = new Server(server, {
  maxHttpBufferSize: 5e7, // 50 MB limit for file uploads
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let currentAdminId = null;
let connectedDevices = [];
let playlist = [
  { id: 'default-1', title: 'Default Demo Track', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' }
];
let currentSongIndex = 0;
let isGlobalMuted = false;

function broadcastDeviceList() {
  io.emit('device_list_update', { devices: connectedDevices, total: connectedDevices.length, isGlobalMuted });
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  connectedDevices.push({
    id: socket.id,
    isAdmin: false,
    isMuted: false
  });

  broadcastDeviceList();

  // Sync state to newly connected client
  socket.emit('queue_update', { playlist, currentSongIndex });
  socket.emit('global_mute_state', { isMuted: isGlobalMuted });

  // Admin authentication
  socket.on('admin_login', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      currentAdminId = socket.id;
      const dev = connectedDevices.find(d => d.id === socket.id);
      if (dev) dev.isAdmin = true;
      socket.emit('login_result', { success: true });
      broadcastDeviceList();
    } else {
      socket.emit('login_result', { success: false, message: "Invalid Password" });
    }
  });

  // Global mute toggle (affects every client)
  socket.on('toggle_global_mute', () => {
    if (socket.id === currentAdminId) {
      isGlobalMuted = !isGlobalMuted;
      io.emit('global_mute_state', { isMuted: isGlobalMuted });
      broadcastDeviceList();
    }
  });

  // Individual device mute toggle
  socket.on('toggle_device_mute', (targetSocketId) => {
    if (socket.id === currentAdminId) {
      const targetDevice = connectedDevices.find(d => d.id === targetSocketId);
      if (targetDevice) {
        targetDevice.isMuted = !targetDevice.isMuted;
        io.to(targetSocketId).emit('device_mute_state', { isMuted: targetDevice.isMuted });
        broadcastDeviceList();
      }
    }
  });

  // Queue operations
  socket.on('add_to_queue', (song) => {
    if (socket.id === currentAdminId) {
      playlist.push(song);
      io.emit('queue_update', { playlist, currentSongIndex });
    }
  });

  socket.on('remove_from_queue', (index) => {
    if (socket.id === currentAdminId && index >= 0 && index < playlist.length) {
      playlist.splice(index, 1);
      if (currentSongIndex >= playlist.length) {
        currentSongIndex = Math.max(0, playlist.length - 1);
      }
      io.emit('queue_update', { playlist, currentSongIndex });
    }
  });

  socket.on('select_song', (index) => {
    if (socket.id === currentAdminId && index >= 0 && index < playlist.length) {
      currentSongIndex = index;
      const song = playlist[currentSongIndex];
      io.emit('change_track', { song, index: currentSongIndex });
      io.emit('queue_update', { playlist, currentSongIndex });
    }
  });

  // Transport & Mixer sync
  socket.on('play', (data) => { if (socket.id === currentAdminId) socket.broadcast.emit('play', data); });
  socket.on('pause', (data) => { if (socket.id === currentAdminId) socket.broadcast.emit('pause', data); });
  socket.on('seek', (data) => { if (socket.id === currentAdminId) socket.broadcast.emit('seek', data); });
  socket.on('mixer_update', (data) => { if (socket.id === currentAdminId) socket.broadcast.emit('mixer_update', data); });

  socket.on('disconnect', () => {
    if (socket.id === currentAdminId) currentAdminId = null;
    connectedDevices = connectedDevices.filter(d => d.id !== socket.id);
    broadcastDeviceList();
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
