const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static files from root and public directories
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let connectedAdmins = new Set();
let currentPlaybackState = {
    isPlaying: false,
    startTimestamp: 0,
    seekPosition: 0
};

io.on('connection', (socket) => {
    console.log(`[Device Connected] ID: ${socket.id}`);

    // Register Role (Max 2 Admins allowed)
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

        // Send latest sync state to freshly connected client
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

    // Handle Admin Master Audio Commands
    socket.on('admin-audio-action', (data) => {
        if (socket.role !== 'admin') return;

        currentPlaybackState = {
            isPlaying: data.action === 'play',
            startTimestamp: data.timestamp || Date.now(),
            seekPosition: data.seekPosition || 0
        };

        // Broadcast synchronized audio event to all connected devices
        io.emit('audio-sync-receive', {
            action: data.action,
            startTimestamp: currentPlaybackState.startTimestamp,
            seekPosition: currentPlaybackState.seekPosition,
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
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sync Speaker Studio server running on port ${PORT}`);
});
