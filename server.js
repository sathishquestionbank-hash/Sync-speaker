const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// Set max buffer size to 50MB for uploading audio files
const io = new Server(server, {
  maxHttpBufferSize: 5e7,
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let currentAdminId = null;
let connectedDevices = [];
let playlist = [
  { id: 'default-1', title: 'Default Demo Track', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' }
];
let currentSongIndex = 0;

function broadcastDeviceList() {
  const devices = connectedDevices.map(id => ({
    id,
    isAdmin: id === currentAdminId
  }));
  io.emit('device_list_update', { devices, total: devices.length });
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  connectedDevices.push(socket.id);
  broadcastDeviceList();

  // Send initial state to newly connected client
  socket.emit('queue_update', { playlist, currentSongIndex });

  // Admin Authentication
  socket.on('admin_login', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      currentAdminId = socket.id;
      socket.emit('login_result', { success: true });
      broadcastDeviceList();
    } else {
      socket.emit('login_result', { success: false, message: "Invalid Password" });
    }
  });

  // Queue Operations (Admin Only)
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

  // Real-Time Transport Synchronization
  socket.on('play', (data) => {
    if (socket.id === currentAdminId) socket.broadcast.emit('play', data);
  });

  socket.on('pause', (data) => {
    if (socket.id === currentAdminId) socket.broadcast.emit('pause', data);
  });

  socket.on('seek', (data) => {
    if (socket.id === currentAdminId) socket.broadcast.emit('seek', data);
  });

  socket.on('mixer_update', (data) => {
    if (socket.id === currentAdminId) socket.broadcast.emit('mixer_update', data);
  });

  socket.on('disconnect', () => {
    if (socket.id === currentAdminId) currentAdminId = null;
    connectedDevices = connectedDevices.filter(id => id !== socket.id);
    broadcastDeviceList();
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
