const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Passwords
const ADMIN_PASSWORD = "1234";
const LISTENER_PASSWORD = "listenpass";

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let connectedAdmins = new Set();
let devicesMap = new Map(); // Stores device metadata: role, channel, latency, eq, vol
let trackQueue = [];
let globalEqMode = 'flat';
let sleepTimerData = { endTime: 0 };
let currentPlaybackState = {
    isPlaying: false,
    startTimestamp: 0,
    seekPosition: 0,
    playbackRate: 1.0
};

function getDeviceList() {
    const list = [];
    devicesMap.forEach((info, id) => {
        list.push({ id, ...info });
    });
    return list;
}

function broadcastDeviceList() {
    io.emit('device-list-update', getDeviceList());
}

io.on('connection', (socket) => {
    // Initialize default per-device settings
    devicesMap.set(socket.id, {
        role: 'unassigned',
        latency: 0,
        channel: 'center',
        volume: 1.0,
        eq: { bass: 0, mid: 0, treble: 0 }
    });

    socket.on('register-role', (data) => {
        const requestedRole = typeof data === 'string' ? data : data.role;
        const passwordInput = data ? data.password : '';

        if (requestedRole === 'admin') {
            if (passwordInput !== ADMIN_PASSWORD) {
                socket.emit('role-assigned', { 
                    success: false, 
                    message: 'Admin Authentication Failed: Incorrect Password' 
                });
                return;
            }

            if (connectedAdmins.size < 2) {
                connectedAdmins.add(socket.id);
                socket.role = 'admin';
                devicesMap.get(socket.id).role = 'admin';
                socket.emit('role-assigned', { success: true, role: 'admin' });
            } else {
                socket.role = 'listener';
                devicesMap.get(socket.id).role = 'listener';
                socket.emit('role-assigned', { 
                    success: true, 
                    role: 'listener', 
                    message: 'Admin slots full. Connected as Listener.' 
                });
            }
        } else {
            // Listener password check
            if (passwordInput !== LISTENER_PASSWORD) {
                socket.emit('role-assigned', { 
                    success: false, 
                    message: 'Listener Access Failed: Incorrect Password' 
                });
                return;
            }

            socket.role = 'listener';
            devicesMap.get(socket.id).role = 'listener';
            socket.emit('role-assigned', { success: true, role: 'listener' });
        }

        socket.emit('sync-state', currentPlaybackState);
        socket.emit('update-song-list', trackQueue);
        socket.emit('eq-update', globalEqMode);
        socket.emit('sleep-timer-sync', sleepTimerData);

        broadcastDeviceList();
    });

    // Time sync & latency tracking
    socket.on('time-sync-ping', (clientTime) => {
        const serverTime = Date.now();
        socket.emit('time-sync-pong', { clientTime, serverTime });
    });

    socket.on('report-latency', (latencyMs) => {
        const dev = devicesMap.get(socket.id);
        if (dev) {
            dev.latency = Math.round(latencyMs);
            broadcastDeviceList();
        }
    });

    // Admin targeting individual devices for Spatial Surround & Equalizer
    socket.on('admin-target-device-dsp', (data) => {
        if (socket.role !== 'admin') return;
        const { targetDeviceId, channel, volume, eq } = data;

        const dev = devicesMap.get(targetDeviceId);
        if (dev) {
            if (channel !== undefined) dev.channel = channel;
            if (volume !== undefined) dev.volume = volume;
            if (eq !== undefined) dev.eq = eq;

            // Direct payload to target device
            io.to(targetDeviceId).emit('apply-custom-dsp', {
                channel: dev.channel,
                volume: dev.volume,
                eq: dev.eq
            });

            broadcastDeviceList();
        }
    });

    // Queue Management
    socket.on('add-song-to-queue', (song) => {
        if (socket.role !== 'admin') return;
        trackQueue.push(song);
        io.emit('update-song-list', trackQueue);
    });

    socket.on('admin-play-queue-index', (index) => {
        if (socket.role !== 'admin' || !trackQueue[index]) return;
        
        currentPlaybackState.isPlaying = true;
        currentPlaybackState.startTimestamp = Date.now();
        currentPlaybackState.seekPosition = 0;

        io.emit('audio-sync-receive', {
            action: 'play',
            startTimestamp: currentPlaybackState.startTimestamp,
            seekPosition: 0,
            playbackRate: currentPlaybackState.playbackRate,
            serverTime: Date.now()
        });
    });

    socket.on('admin-audio-action', (data) => {
        if (socket.role !== 'admin') return;

        currentPlaybackState = {
            isPlaying: data.action === 'play',
            startTimestamp: data.timestamp || Date.now(),
            seekPosition: data.seekPosition || 0,
            playbackRate: data.playbackRate || currentPlaybackState.playbackRate
        };

        io.emit('audio-sync-receive', {
            action: data.action,
            startTimestamp: currentPlaybackState.startTimestamp,
            seekPosition: currentPlaybackState.seekPosition,
            playbackRate: currentPlaybackState.playbackRate,
            serverTime: Date.now()
        });
    });

    socket.on('disconnect', () => {
        if (socket.role === 'admin') connectedAdmins.delete(socket.id);
        devicesMap.delete(socket.id);
        broadcastDeviceList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sync Speaker Studio running on port ${PORT}`);
});
