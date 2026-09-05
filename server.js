const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8 // Allow up to 100MB file uploads
});

app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MAX_ADMINS = 2;

let activeAdminsCount = 0;
let isGlobalMuted = false;

// Global audio settings (Pan, Master Volume, EQ, etc.)
let globalAudioSettings = {
  pan: 0
};

// Store connected devices and their individual settings
const connectedDevices = new Map();

// Song Queue State
let playlist = [
  { id: 'demo-1', title: 'Default Demo Track', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' }
];
let currentSongIndex = 0;

function broadcastDeviceList() {
  const devicesArr = Array.from(connectedDevices.entries()).map(([id, info]) => ({
    id,
    isAdmin: info.isAdmin,
    isMuted: info.isMuted,
    settings: info.settings
  }));

  io.emit('device_list_update', {
    total: devicesArr.length,
    devices: devicesArr
  });
}

io.on('connection', (socket) => {
  // Initialize device state with default delay and pan settings
  connectedDevices.set(socket.id, {
    isAdmin: false,
    isMuted: false,
    settings: {
      delay: 0,
      pan: 0
    }
  });

  // Send current queue state & global settings to newly connected device
  socket.emit('queue_update', { playlist, currentSongIndex });
  socket.emit('global_mute_state', { isMuted: isGlobalMuted });
  socket.emit('apply_global_audio_setting', { param: 'pan', value: globalAudioSettings.pan });
  
  broadcastDeviceList();

  // Admin Login Handler
  socket.on('admin_login', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      if (activeAdminsCount >= MAX_ADMINS) {
        return socket.emit('login_result', { success: false, message: 'Max admin limit reached (Max 2).' });
      }

      const dev = connectedDevices.get(socket.id);
      if (dev) {
        dev.isAdmin = true;
        activeAdminsCount++;
        socket.emit('login_result', { success: true });
        broadcastDeviceList();
      }
    } else {
      socket.emit('login_result', { success: false, message: 'Incorrect password.' });
    }
  });

  // Global Mute Handler
  socket.on('toggle_global_mute', () => {
    const dev = connectedDevices.get(socket.id);
    if (!dev || !dev.isAdmin) return;

    isGlobalMuted = !isGlobalMuted;
    io.emit('global_mute_state', { isMuted: isGlobalMuted });
  });

  // Individual Device Mute Handler
  socket.on('toggle_device_mute', (targetId) => {
    const dev = connectedDevices.get(socket.id);
    if (!dev || !dev.isAdmin) return;

    const targetDev = connectedDevices.get(targetId);
    if (targetDev) {
      targetDev.isMuted = !targetDev.isMuted;
      io.to(targetId).emit('device_mute_state', { isMuted: targetDev.isMuted });
      broadcastDeviceList();
    }
  });

  // Update Individual Audio Settings (Delay, Pan)
  socket.on('update_device_audio_setting', (data) => {
    const dev = connectedDevices.get(socket.id);
    if (!dev || !dev.isAdmin) return;

    const { targetId, param, value } = data;
    const targetDev = connectedDevices.get(targetId);

    if (targetDev) {
      if (!targetDev.settings) targetDev.settings = {};
      targetDev.settings[param] = value;

      // Direct target device to adjust its AudioContext nodes
      io.to(targetId).emit('apply_device_audio_setting', { param, value });
      broadcastDeviceList();
    }
  });

  // Update Global Audio Settings (Global Pan)
  socket.on('update_global_audio_setting', (data) => {
    const dev = connectedDevices.get(socket.id);
    if (!dev || !dev.isAdmin) return;

    const { param, value } = data;
    globalAudioSettings[param] = value;

    // Broadcast global settings change to every connected listener
    io.emit('apply_global_audio_setting', { param, value });
  });

  // Queue Management
  socket.on('add_to_queue', (song) => {
    playlist.push(song);
    io.emit('queue_update', { playlist, currentSongIndex });
  });

  socket.on('select_song', (index) => {
    const dev = connectedDevices.get(socket.id);
    if (!dev || !dev.isAdmin) return;

    if (index >= 0 && index < playlist.length) {
      currentSongIndex = index;
      io.emit('queue_update', { playlist, currentSongIndex });
      io.emit('change_track', { song: playlist[currentSongIndex] });
    }
  });

  socket.on('remove_from_queue', (index) => {
    const dev = connectedDevices.get(socket.id);
    if (!dev || !dev.isAdmin) return;

    if (index >= 0 && index < playlist.length) {
      playlist.splice(index, 1);
      if (currentSongIndex >= playlist.length) {
        currentSongIndex = Math.max(0, playlist.length - 1);
      }
      io.emit('queue_update', { playlist, currentSongIndex });
    }
  });

  // Playback Control Syncing
  socket.on('play', (data) => {
    const dev = connectedDevices.get(socket.id);
    if (dev && dev.isAdmin) socket.broadcast.emit('play', data);
  });

  socket.on('pause', (data) => {
    const dev = connectedDevices.get(socket.id);
    if (dev && dev.isAdmin) socket.broadcast.emit('pause', data);
  });

  socket.on('seek', (data) => {
    const dev = connectedDevices.get(socket.id);
    if (dev && dev.isAdmin) socket.broadcast.emit('seek', data);
  });

  // WebRTC Live Mic Signaling
  socket.on('webrtc_offer', (data) => {
    io.to(data.targetId).emit('webrtc_offer', { senderId: socket.id, sdp: data.sdp });
  });

  socket.on('webrtc_answer', (data) => {
    io.to(data.targetId).emit('webrtc_answer', { senderId: socket.id, sdp: data.sdp });
  });

  socket.on('webrtc_ice_candidate', (data) => {
    io.to(data.targetId).emit('webrtc_ice_candidate', { senderId: socket.id, candidate: data.candidate });
  });

  socket.on('stop_mic_broadcast', () => {
    socket.broadcast.emit('stop_webrtc_stream');
  });

  // Disconnect Handler
  socket.on('disconnect', () => {
    const dev = connectedDevices.get(socket.id);
    if (dev && dev.isAdmin) {
      activeAdminsCount = Math.max(0, activeAdminsCount - 1);
    }
    connectedDevices.delete(socket.id);
    broadcastDeviceList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sync Speaker Studio running on port ${PORT}`);
});
