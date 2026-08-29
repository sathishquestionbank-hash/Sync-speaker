const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const DEFAULT_ADMIN_PASS = "1234";
const DEFAULT_LISTEN_PASS = "listenpass";

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Multi-room session management state
let rooms = new Map();

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            adminPassword: DEFAULT_ADMIN_PASS,
            listenerPassword: DEFAULT_LISTEN_PASS,
            connectedAdmins: new Set(),
            devicesMap: new Map(),
            trackQueue: [],
            currentEqMode: 'flat',
            sleepTimerData: { endTime: 0 },
            autoPan: { enabled: false, speed: 1.0 },
            currentPlaybackState: {
                isPlaying: false,
                startTimestamp: 0,
                seekPosition: 0,
                playbackRate: 1.0,
                currentTrackName: "No Track Loaded",
                duration: 0
            }
        });
    }
    return rooms.get(roomId);
}

function getDeviceList(room) {
    const list = [];
    room.devicesMap.forEach((info, id) => {
        list.push({ id, ...info });
    });
    return list;
}

function broadcastDeviceList(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        io.to(roomId).emit('device-list-update', getDeviceList(room));
    }
}

io.on('connection', (socket) => {
    let currentRoomId = 'MainStudio';

    socket.on('register-role', (data) => {
        currentRoomId = data.roomId || 'MainStudio';
        const room = getOrCreateRoom(currentRoomId);
        
        const requestedRole = data.role;
        const passwordInput = data.password || '';

        if (requestedRole === 'admin') {
            if (passwordInput !== room.adminPassword) {
                socket.emit('role-assigned', { 
                    success: false, 
                    message: 'Admin Authentication Failed: Incorrect Password' 
                });
                return;
            }

            if (room.connectedAdmins.size < 2) {
                room.connectedAdmins.add(socket.id);
                socket.role = 'admin';
                socket.roomId = currentRoomId;
                socket.join(currentRoomId);
            } else {
                socket.role = 'listener';
                socket.roomId = currentRoomId;
                socket.join(currentRoomId);
                socket.emit('role-assigned', { 
                    success: true, 
                    role: 'listener', 
                    message: 'Admin slots full. Connected as Listener.' 
                });
                return;
            }
        } else {
            if (passwordInput !== room.listenerPassword) {
                socket.emit('role-assigned', { 
                    success: false, 
                    message: 'Listener Access Failed: Incorrect Password' 
                });
                return;
            }

            socket.role = 'listener';
            socket.roomId = currentRoomId;
            socket.join(currentRoomId);
        }

        room.devicesMap.set(socket.id, {
            role: socket.role,
            latency: 0,
            channel: 'center',
            volume: 1.0,
            isMuted: false,
            eq: { bass: 0, mid: 0, treble: 0 },
            spectrumData: new Array(16).fill(0)
        });

        socket.emit('role-assigned', { success: true, role: socket.role, roomId: currentRoomId });
        socket.emit('sync-state', room.currentPlaybackState);
        socket.emit('update-song-list', room.trackQueue);
        socket.emit('eq-update', room.currentEqMode);
        socket.emit('sleep-timer-sync', room.sleepTimerData);
        socket.emit('auto-pan-state-update', room.autoPan);

        broadcastDeviceList(currentRoomId);
    });

    socket.on('time-sync-ping', (clientTime) => {
        socket.emit('time-sync-pong', { clientTime, serverTime: Date.now() });
    });

    socket.on('report-latency', (latencyMs) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room && room.devicesMap.has(socket.id)) {
            room.devicesMap.get(socket.id).latency = Math.round(latencyMs);
            broadcastDeviceList(socket.roomId);
        }
    });

    // Spectrum Relay for Per-Device Visualizers in Admin View
    socket.on('device-spectrum-stream', (dataArray) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room && room.devicesMap.has(socket.id)) {
            room.devicesMap.get(socket.id).spectrumData = dataArray;
            io.to(socket.roomId).emit('spectrum-stream-broadcast', {
                id: socket.id,
                spectrumData: dataArray
            });
        }
    });

    // Per-Device DSP Controls
    socket.on('admin-target-device-dsp', (data) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        const { targetDeviceId, channel, volume, isMuted, eq } = data;
        const dev = room.devicesMap.get(targetDeviceId);

        if (dev) {
            if (channel !== undefined) dev.channel = channel;
            if (volume !== undefined) dev.volume = volume;
            if (isMuted !== undefined) dev.isMuted = isMuted;
            if (eq !== undefined) dev.eq = eq;

            io.to(targetDeviceId).emit('apply-custom-dsp', {
                channel: dev.channel,
                volume: dev.volume,
                isMuted: dev.isMuted,
                eq: dev.eq
            });

            broadcastDeviceList(socket.roomId);
        }
    });

    // Global Overrides
    socket.on('admin-global-mute', (shouldMute) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        room.devicesMap.forEach((dev, id) => {
            dev.isMuted = shouldMute;
            io.to(id).emit('apply-custom-dsp', { isMuted: shouldMute });
        });
        broadcastDeviceList(socket.roomId);
    });

    // Dynamic Spatial Auto-Panning
    socket.on('admin-toggle-auto-pan', (panSettings) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        room.autoPan = panSettings;
        io.to(socket.roomId).emit('auto-pan-state-update', room.autoPan);
    });

    // Audio Playback & Seeking Sync
    socket.on('admin-audio-action', (data) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        room.currentPlaybackState = {
            isPlaying: data.action === 'play',
            startTimestamp: data.timestamp || Date.now(),
            seekPosition: data.seekPosition || 0,
            playbackRate: data.playbackRate || room.currentPlaybackState.playbackRate,
            currentTrackName: data.trackName || room.currentPlaybackState.currentTrackName,
            duration: data.duration || room.currentPlaybackState.duration
        };

        io.to(socket.roomId).emit('audio-sync-receive', {
            action: data.action,
            startTimestamp: room.currentPlaybackState.startTimestamp,
            seekPosition: room.currentPlaybackState.seekPosition,
            playbackRate: room.currentPlaybackState.playbackRate,
            trackName: room.currentPlaybackState.currentTrackName,
            duration: room.currentPlaybackState.duration,
            serverTime: Date.now()
        });
    });

    socket.on('disconnect', () => {
        if (socket.roomId) {
            const room = rooms.get(socket.roomId);
            if (room) {
                if (socket.role === 'admin') room.connectedAdmins.delete(socket.id);
                room.devicesMap.delete(socket.id);
                broadcastDeviceList(socket.roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sync Speaker Studio server listening on port ${PORT}`);
});
