const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const MAX_ADMINS = 2; // Strict limit on concurrent admins

const io = new Server(server, {
  transports: ['websocket'],
  pingTimeout: 10000,
  pingInterval: 5000,
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let connectedDevices = [];
let playlist = [
  { id: 'default-1', title: 'Default Demo Track', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' }
];
let currentSongIndex = 0;
let isGlobalMuted = false;

function broadcastDeviceList() {
  io.emit('device_list_update', { devices: connectedDevices, total: connectedDevices.length, isGlobalMuted });
}

function getAdminCount() {
  return connectedDevices.filter(d => d.isAdmin).length;
}

io.on('connection', (socket) => {
  connectedDevices.push({
    id: socket.id,
    isAdmin: false,
    isMuted: false,
    settings: { delay: 0, eqLow: 0, eqMid: 0, eqHigh: 0, echoTime: 0, echoFeedback: 0 }
  });

  broadcastDeviceList();

  socket.emit('queue_update', { playlist, currentSongIndex });
  socket.emit('global_mute_state', { isMuted: isGlobalMuted });

  // --- Strict 2-Admin Authentication ---
  socket.on('admin_login', (data) => {
    if (data.password !== ADMIN_PASSWORD) {
      return socket.emit('login_result', { success: false, message: "Invalid Password" });
    }

    if (getAdminCount() >= MAX_ADMINS) {
      return socket.emit('login_result', { 
        success: false, 
        message: `Admin limit reached (${MAX_ADMINS} admins already connected).` 
      });
    }

    const dev = connectedDevices.find(d => d.id === socket.id);
    if (dev) dev.isAdmin = true;

    socket.emit('login_result', { success: true });
    broadcastDeviceList();
  });

  // --- WebRTC Signaling Channels ---
  socket.on('webrtc_offer', (data) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) {
      io.to(data.targetId).emit('webrtc_offer', { sdp: data.sdp, senderId: socket.id });
    }
  });

  socket.on('webrtc_answer', (data) => {
    io.to(data.targetId).emit('webrtc_answer', { sdp: data.sdp, senderId: socket.id });
  });

  socket.on('webrtc_ice_candidate', (data) => {
    io.to(data.targetId).emit('webrtc_ice_candidate', { candidate: data.candidate, senderId: socket.id });
  });

  socket.on('stop_mic_broadcast', () => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) {
      socket.broadcast.emit('stop_webrtc_stream');
    }
  });

  // --- Controls & Playback ---
  socket.on('toggle_global_mute', () => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) {
      isGlobalMuted = !isGlobalMuted;
      io.emit('global_mute_state', { isMuted: isGlobalMuted });
      broadcastDeviceList();
    }
  });

  socket.on('toggle_device_mute', (targetSocketId) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) {
      const targetDevice = connectedDevices.find(d => d.id === targetSocketId);
      if (targetDevice) {
        targetDevice.isMuted = !targetDevice.isMuted;
        io.to(targetSocketId).emit('device_mute_state', { isMuted: targetDevice.isMuted });
        broadcastDeviceList();
      }
    }
  });

  // Individual Device Audio Parameters (including Delay)
  socket.on('update_device_audio_setting', (data) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) {
      const targetDevice = connectedDevices.find(d => d.id === data.targetId);
      if (targetDevice) {
        targetDevice.settings[data.param] = data.value;
        io.to(data.targetId).emit('apply_device_audio_setting', { param: data.param, value: data.value });
      }
    }
  });

  socket.on('add_to_queue', (song) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) {
      playlist.push(song);
      io.emit('queue_update', { playlist, currentSongIndex });
    }
  });

  socket.on('remove_from_queue', (index) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin && index >= 0 && index < playlist.length) {
      playlist.splice(index, 1);
      if (currentSongIndex >= playlist.length) {
        currentSongIndex = Math.max(0, playlist.length - 1);
      }
      io.emit('queue_update', { playlist, currentSongIndex });
    }
  });

  socket.on('select_song', (index) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin && index >= 0 && index < playlist.length) {
      currentSongIndex = index;
      const song = playlist[currentSongIndex];
      io.emit('change_track', { song, index: currentSongIndex });
      io.emit('queue_update', { playlist, currentSongIndex });
    }
  });

  socket.on('play', (data) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) socket.broadcast.emit('play', data);
  });

  socket.on('pause', (data) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) socket.broadcast.emit('pause', data);
  });

  socket.on('seek', (data) => {
    const sender = connectedDevices.find(d => d.id === socket.id);
    if (sender && sender.isAdmin) socket.broadcast.emit('seek', data);
  });

  socket.on('disconnect', () => {
    const dev = connectedDevices.find(d => d.id === socket.id);
    if (dev && dev.isAdmin && getAdminCount() === 1) {
      socket.broadcast.emit('stop_webrtc_stream');
    }
    connectedDevices = connectedDevices.filter(d => d.id !== socket.id);
    broadcastDeviceList();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
