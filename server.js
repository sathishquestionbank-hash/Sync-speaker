const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const ADMIN_PASSWORD = "1234";

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let connectedAdmins = new Set();
let trackQueue = [];
let currentEqMode = 'flat';
let sleepTimerData = { endTime: 0 };
let currentPlaybackState = {
    sourceType: 'local',
    youtubeId: '',
    isPlaying: false,
    startTimestamp: 0,
    seekPosition: 0,
    playbackRate: 1.0
};

io.on('connection', (socket) => {
    console.log(`[Device Connected] ID: ${socket.id}`);

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
                socket.emit('role-assigned', { success: true, role: 'admin' });
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

        socket.emit('sync-state', currentPlaybackState);
        socket.emit('update-song-list', trackQueue);
        socket.emit('eq-update', currentEqMode);
        socket.emit('sleep-timer-sync', sleepTimerData);

        io.emit('stats-update', {
            totalDevices: io.engine.clientsCount,
            adminCount: connectedAdmins.size
        });
    });

    socket.on('time-sync-ping', (clientTime) => {
        socket.emit('time-sync-pong', {
            clientTime: clientTime,
            serverTime: Date.now()
        });
    });

    // Queue Management
    socket.on('add-song-to-queue', (song) => {
        if (socket.role !== 'admin') return;
        trackQueue.push(song);
        io.emit('update-song-list', trackQueue);
    });

    socket.on('admin-play-queue-index', (index) => {
        if (socket.role !== 'admin' || !trackQueue[index]) return;
        const song = trackQueue[index];
        
        currentPlaybackState.sourceType = song.type === 'YouTube' ? 'youtube' : 'local';
        currentPlaybackState.youtubeId = song.ytId || '';
        currentPlaybackState.isPlaying = true;
        currentPlaybackState.startTimestamp = Date.now();
        currentPlaybackState.seekPosition = 0;

        io.emit('audio-sync-receive', {
            action: 'play',
            sourceType: currentPlaybackState.sourceType,
            youtubeId: currentPlaybackState.youtubeId,
            startTimestamp: currentPlaybackState.startTimestamp,
            seekPosition: 0,
            playbackRate: currentPlaybackState.playbackRate,
            serverTime: Date.now()
        });
    });

    // DSP Equalizer Broadcast
    socket.on('admin-eq-change', (mode) => {
        if (socket.role !== 'admin') return;
        currentEqMode = mode;
        io.emit('eq-update', currentEqMode);
    });

    // Cluster Sleep Timer
    socket.on('admin-sleep-timer', (minutes) => {
        if (socket.role !== 'admin') return;
        sleepTimerData.endTime = minutes > 0 ? Date.now() + (minutes * 60 * 1000) : 0;
        io.emit('sleep-timer-sync', sleepTimerData);
    });

    // Live Voice Paging Chunk Relay
    socket.on('mic-audio-chunk', (chunk) => {
        if (socket.role !== 'admin') return;
        socket.broadcast.emit('receive-mic-chunk', chunk);
    });

    // Master Sync Control Actions
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
    console.log(`Sync Speaker Studio running on port ${PORT}`);
});
