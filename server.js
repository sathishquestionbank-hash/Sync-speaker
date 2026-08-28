const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static files from root directory or public folder
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let connectedAdmins = new Set();
let currentPlaybackState = {
    isPlaying: false,
    audioUrl: null,
    startTimestamp: 0,
    seekPosition: 0
};

io.on('connection', (socket) => {
    console.log(`[Connected] Device ID: ${socket.id}`);

    // Role Registration (Max 2 Admins)
    socket.on('register-role', (requestedRole) => {
        if (requestedRole === 'admin') {
            if (connectedAdmins.size < 2) {
                connectedAdmins.add(socket.id);
                socket.role = 'admin';
                socket.emit('role-assigned', { role: 'admin', count: connectedAdmins.size });
            } else {
                socket.role = 'listener';
                socket.emit('role-assigned', { 
                    role: 'listener', 
                    message: 'Admin slots full (Max 2). Connected as Listener.' 
                });
            }
        } else {
            socket.role = 'listener';
            socket.emit('role-assigned', { role: 'listener' });
        }

        // Send current playback state to new connections
        socket.emit('sync-state', currentPlaybackState);

        io.emit('stats-update', {
            totalDevices: io.engine.clientsCount,
            adminCount: connectedAdmins.size
        });
    });

    // Time Synchronization Ping-Pong for Drift Calculation
    socket.on('time-sync-ping', (clientTime) => {
        socket.emit('time-sync-pong', {
            clientTime: clientTime,
            serverTime: Date.now()
        });
    });

    // Master Audio Control Actions (Admin Only)
    socket.on('admin-audio-action', (data) => {
        if (socket.role !== 'admin') return;

        currentPlaybackState = {
            isPlaying: data.action === 'play',
            audioUrl: data.audioUrl || currentPlaybackState.audioUrl,
            startTimestamp: data.timestamp || Date.now(),
            seekPosition: data.seekPosition || 0
        };

        // Broadcast sync signal to all listeners and other admin
        io.emit('audio-sync-receive', {
            action: data.action,
            audioUrl: currentPlaybackState.audioUrl,
            startTimestamp: currentPlaybackState.startTimestamp,
            seekPosition: currentPlaybackState.seekPosition,
            serverTime: Date.now()
        });
    });

    // Handle Disconnects
    socket.on('disconnect', () => {
        if (socket.role === 'admin') {
            connectedAdmins.delete(socket.id);
        }
        io.emit('stats-update', {
            totalDevices: io.engine.clientsCount,
            adminCount: connectedAdmins.size
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sync Speaker Studio running on port ${PORT}`);
});
