const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const DEFAULT_ADMIN_PASS = "1234";
const DEFAULT_LISTEN_PASS = "listenpass";

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let rooms = new Map();

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            adminPassword: DEFAULT_ADMIN_PASS,
            listenerPassword: DEFAULT_LISTEN_PASS,
            connectedAdmins: new Set(),
            devicesMap: new Map(),
            playlist: [],
            currentTrackIndex: -1,
            isRepeat: false,
            autoPan: { enabled: false, speed: 1.0 },
            currentPlaybackState: {
                isPlaying: false,
                startTimestamp: 0,
                seekPosition: 0,
                playbackRate: 1.0,
                currentTrackName: "No Track Selected",
                duration: 0
            }
        });
    }
    return rooms.get(roomId);
}

function getDeviceList(room) {
    const list = [];
    room.devicesMap.forEach((info, id) => list.push({ id, ...info }));
    return list;
}

function broadcastDeviceList(roomId) {
    const room = rooms.get(roomId);
    if (room) io.to(roomId).emit('device-list-update', getDeviceList(room));
}

function broadcastPlaylist(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        io.to(roomId).emit('playlist-update', {
            playlist: room.playlist,
            currentIndex: room.currentTrackIndex,
            isRepeat: room.isRepeat
        });
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
                socket.emit('role-assigned', { success: false, message: 'Admin Auth Failed' });
                return;
            }
            if (room.connectedAdmins.size < 2) {
                room.connectedAdmins.add(socket.id);
                socket.role = 'admin';
            } else {
                socket.role = 'listener';
                socket.emit('role-assigned', { success: true, role: 'listener', message: 'Admin full, joined as listener' });
            }
        } else {
            if (passwordInput !== room.listenerPassword) {
                socket.emit('role-assigned', { success: false, message: 'Listener Auth Failed' });
                return;
            }
            socket.role = 'listener';
        }

        socket.roomId = currentRoomId;
        socket.join(currentRoomId);

        room.devicesMap.set(socket.id, {
            role: socket.role,
            latency: 0,
            channel: 'center',
            zone: 'Main Hall',
            volume: 1.0,
            isMuted: false,
            posX: 0,
            posY: -1,
            eq: { bass: 0, mid: 0, treble: 0 },
            spectrumData: new Array(16).fill(0)
        });

        socket.emit('role-assigned', { success: true, role: socket.role, roomId: currentRoomId });
        socket.emit('sync-state', room.currentPlaybackState);
        socket.emit('auto-pan-state-update', room.autoPan);
        
        broadcastDeviceList(currentRoomId);
        broadcastPlaylist(currentRoomId);
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

    socket.on('device-spectrum-stream', (dataArray) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room && room.devicesMap.has(socket.id)) {
            room.devicesMap.get(socket.id).spectrumData = dataArray;
            io.to(socket.roomId).emit('spectrum-stream-broadcast', { id: socket.id, spectrumData: dataArray });
        }
    });

    // 2D Spatial Positioning Updates
    socket.on('admin-update-node-position', (data) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        const dev = room.devicesMap.get(data.targetDeviceId);
        if (dev) {
            dev.posX = data.x;
            dev.posY = data.y;
            io.to(data.targetDeviceId).emit('apply-spatial-position', { x: data.x, y: data.y });
            broadcastDeviceList(socket.roomId);
        }
    });

    // Zone & DSP Controls
    socket.on('admin-target-device-dsp', (data) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        const dev = room.devicesMap.get(data.targetDeviceId);
        if (dev) {
            if (data.channel !== undefined) dev.channel = data.channel;
            if (data.zone !== undefined) dev.zone = data.zone;
            if (data.volume !== undefined) dev.volume = data.volume;
            if (data.isMuted !== undefined) dev.isMuted = data.isMuted;
            if (data.eq !== undefined) {
                if (data.eq.bass !== undefined) dev.eq.bass = data.eq.bass;
                if (data.eq.mid !== undefined) dev.eq.mid = data.eq.mid;
                if (data.eq.treble !== undefined) dev.eq.treble = data.eq.treble;
            }

            io.to(data.targetDeviceId).emit('apply-custom-dsp', {
                channel: dev.channel,
                volume: dev.volume,
                isMuted: dev.isMuted,
                eq: dev.eq
            });
            broadcastDeviceList(socket.roomId);
        }
    });

    // Live Mic Paging Broadcasts
    socket.on('admin-mic-stream', (audioChunk) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        socket.to(socket.roomId).emit('listener-receive-mic', audioChunk);
    });

    socket.on('admin-mic-state', (isSpeaking) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        socket.to(socket.roomId).emit('listener-mic-ducking', isSpeaking);
    });

    // Playlist Controls
    socket.on('admin-add-to-playlist', (tracks) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;
        tracks.forEach(track => room.playlist.push(track));
        if (room.currentTrackIndex === -1 && room.playlist.length > 0) room.currentTrackIndex = 0;
        broadcastPlaylist(socket.roomId);
    });

    socket.on('admin-select-track', (index) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room || index < 0 || index >= room.playlist.length) return;

        room.currentTrackIndex = index;
        const track = room.playlist[index];
        room.currentPlaybackState = {
            isPlaying: true,
            startTimestamp: Date.now(),
            seekPosition: 0,
            playbackRate: room.currentPlaybackState.playbackRate || 1.0,
            currentTrackName: track.name,
            duration: track.duration
        };

        broadcastPlaylist(socket.roomId);
        io.to(socket.roomId).emit('audio-sync-receive', {
            action: 'play-track-index',
            index: index,
            startTimestamp: room.currentPlaybackState.startTimestamp,
            seekPosition: 0,
            playbackRate: room.currentPlaybackState.playbackRate,
            trackName: track.name,
            serverTime: Date.now()
        });
    });

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
server.listen(PORT, '0.0.0.0', () => console.log(`Sync Speaker Studio operating on port ${PORT}`));
