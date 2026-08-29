const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Configuration
const ADMIN_PASSWORD = "1234"; // Set your desired Admin password here

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let connectedAdmins = new Set();
let currentPlaybackState = {
    sourceType: 'local', // 'local' or 'youtube'
    youtubeId: '',
    isPlaying: false,
    startTimestamp: 0,
    seekPosition: 0,
    playbackRate: 1.0
};

io.on('connection', (socket) => {
    console.log(`[Device Connected] ID: ${socket.id}`);

    // Handle Role Registration and Passcode Verification
    socket.on('register-role', (data) => {
        const requestedRole = typeof data === 'string' ? data : data.role;
        const passwordInput = data.password || '';

        if (requestedRole === 'admin') {
            if (passwordInput !== ADMIN_PASSWORD) {
                socket.emit('role-assigned', { 
                    success: false, 
                    message: 'Authentication failed: Incorrect Password' 
                });
                return;
            }

            if (connectedAdmins.size < 2) {
                connectedAdmins.add(socket.id);
                socket.role = 'admin';
                socket.emit('role-assigned', { 
                    success: true, 
                    role: 'admin', 
                    count: connectedAdmins.size 
                });
            } else {
                socket.role = 'listener';
                socket.emit('role-assigned', { 
                    success: true, 
                    role: 'listener', 
                    message: 'Admin slots full (Max 2). Connected as Listener.' 
                });
            }
        } else {
            socket.role = 'listener';
            socket.emit('role-assigned', { success: true, role: 'listener' });
        }

        // Catch new device up with current playback status
        socket.emit('sync-state', currentPlaybackState);

        io.emit('stats-update', {
            totalDevices: io.engine.clientsCount,
            adminCount: connectedAdmins.size
        });
    });

    // Precision Time-Sync Ping-Pong
    socket.on('time-sync-ping', (clientTime) => {
        socket.emit('time-sync-pong', {
            clientTime: clientTime,
            serverTime: Date.now()
        });
    });

    // Handle Admin Playback, Speed & Track Commands
    socket.on('admin-audio-action', (data) => {
        if (socket.role !== 'admin') return;

        currentPlaybackState = {
            sourceType: data.sourceType || 'local',
            youtubeId: data.youtubeId || currentPlaybackState.youtubeId,
            isPlaying: data.action === 'play',
            startTimestamp: data.timestamp || Date.now(),
            seekPosition: data.seekPosition || 0,
            playbackRate: data.playbackRate || currentPlaybackState.playbackRate
        };

        io.emit('audio-sync-receive', {
            action: data.action,
            sourceType: currentPlaybackState.sourceType,
            youtubeId: currentPlaybackState.youtubeId,
            startTimestamp: currentPlaybackState.startTimestamp,
            seekPosition: currentPlaybackState.seekPosition,
            playbackRate: currentPlaybackState.playbackRate,
            serverTime: Date.now()
        });
    });

    socket.on('disconnect', () => {
        if (socket.role === 'admin') {
            connectedAdmins.delete(socket.id);
        }
        io.emit('stats-update', {
            totalDevices: io.engine.clientsCount,
            adminCount: connectedAdmins.size
        });
        console.log(`[Device Disconnected] ID: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sync Speaker Studio server running on port ${PORT}`);
});
