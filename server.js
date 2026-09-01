const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8 // 100MB max payload limit
});

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
            playlist: [], // Stores { id, name, arrayBuffer }
            currentTrackIndex: -1,
            isRepeat: false,
            isShuffle: false,
            crossfadeDuration: 3,
            masterPreset: 'flat',
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
        const sanitizedPlaylist = room.playlist.map((item) => ({
            id: item.id,
            name: item.name
        }));
        io.to(roomId).emit('playlist-update', {
            playlist: sanitizedPlaylist,
            currentIndex: room.currentTrackIndex,
            isRepeat: room.isRepeat,
            isShuffle: room.isShuffle
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
            room.connectedAdmins.add(socket.id);
            socket.role = 'admin';
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
            delayMs: 0,
            zone: 'Main Hall',
            volume: 1.0,
            isMuted: false,
            eq: { bass: 0, mid: 0, treble: 0 },
            spectrumData: new Array(16).fill(0)
        });

        socket.emit('role-assigned', { success: true, role: socket.role, roomId: currentRoomId });
        socket.emit('sync-state', room.currentPlaybackState);
        socket.emit('sync-crossfade', room.crossfadeDuration);
        
        broadcastDeviceList(currentRoomId);
        broadcastPlaylist(currentRoomId);

        if (room.currentTrackIndex !== -1 && room.playlist[room.currentTrackIndex]) {
            const currentTrack = room.playlist[room.currentTrackIndex];
            socket.emit('load-audio-buffer', {
                trackName: currentTrack.name,
                buffer: currentTrack.arrayBuffer
            });
        }
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

    // Master DSP Presets
    socket.on('admin-apply-dsp-preset', (presetName) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        let presetEq = { bass: 0, mid: 0, treble: 0 };
        switch(presetName) {
            case 'bass-boost': presetEq = { bass: 8, mid: -1, treble: 2 }; break;
            case 'club': presetEq = { bass: 6, mid: 2, treble: 5 }; break;
            case 'vocal': presetEq = { bass: -4, mid: 6, treble: 3 }; break;
            case 'acoustic': presetEq = { bass: 3, mid: 1, treble: 4 }; break;
            default: presetEq = { bass: 0, mid: 0, treble: 0 };
        }

        room.masterPreset = presetName;
        room.devicesMap.forEach((dev) => { dev.eq = { ...presetEq }; });
        io.to(socket.roomId).emit('apply-room-dsp-preset', presetEq);
        broadcastDeviceList(socket.roomId);
    });

    // Targeted DSP & Delay Tuning
    socket.on('admin-target-device-dsp', (data) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        const dev = room.devicesMap.get(data.targetDeviceId);
        if (dev) {
            if (data.zone !== undefined) dev.zone = data.zone;
            if (data.volume !== undefined) dev.volume = data.volume;
            if (data.isMuted !== undefined) dev.isMuted = data.isMuted;
            if (data.delayMs !== undefined) dev.delayMs = data.delayMs;
            if (data.eq !== undefined) {
                if (data.eq.bass !== undefined) dev.eq.bass = data.eq.bass;
                if (data.eq.mid !== undefined) dev.eq.mid = data.eq.mid;
                if (data.eq.treble !== undefined) dev.eq.treble = data.eq.treble;
            }

            io.to(data.targetDeviceId).emit('apply-custom-dsp', {
                volume: dev.volume,
                isMuted: dev.isMuted,
                delayMs: dev.delayMs,
                eq: dev.eq
            });
            broadcastDeviceList(socket.roomId);
        }
    });

    // Playlist Controls & Reordering
    socket.on('admin-upload-tracks', (filesData) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        filesData.forEach((file) => {
            room.playlist.push({
                id: 'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                name: file.name,
                arrayBuffer: file.buffer
            });
        });

        if (room.currentTrackIndex === -1 && room.playlist.length > 0) {
            room.currentTrackIndex = 0;
        }

        broadcastPlaylist(socket.roomId);
    });

    socket.on('admin-remove-track', (index) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room || index < 0 || index >= room.playlist.length) return;

        room.playlist.splice(index, 1);
        if (room.currentTrackIndex >= room.playlist.length) {
            room.currentTrackIndex = room.playlist.length - 1;
        }
        broadcastPlaylist(socket.roomId);
    });

    socket.on('admin-reorder-playlist', ({ fromIndex, toIndex }) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room) return;

        const [movedTrack] = room.playlist.splice(fromIndex, 1);
        room.playlist.splice(toIndex, 0, movedTrack);

        if (room.currentTrackIndex === fromIndex) {
            room.currentTrackIndex = toIndex;
        }
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
            duration: 0
        };

        io.to(socket.roomId).emit('load-audio-buffer', {
            trackName: track.name,
            buffer: track.arrayBuffer
        });

        broadcastPlaylist(socket.roomId);
        
        io.to(socket.roomId).emit('audio-sync-receive', {
            action: 'play',
            index: index,
            startTimestamp: room.currentPlaybackState.startTimestamp,
            seekPosition: 0,
            playbackRate: room.currentPlaybackState.playbackRate,
            trackName: track.name,
            serverTime: Date.now(),
            crossfade: room.crossfadeDuration
        });
    });

    socket.on('admin-toggle-repeat', () => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room) { room.isRepeat = !room.isRepeat; broadcastPlaylist(socket.roomId); }
    });

    socket.on('admin-toggle-shuffle', () => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room) { room.isShuffle = !room.isShuffle; broadcastPlaylist(socket.roomId); }
    });

    socket.on('admin-trigger-auto-advance', () => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (!room || room.playlist.length === 0) return;

        let nextIndex = room.currentTrackIndex;
        if (room.isRepeat) {
            // Keep current index
        } else if (room.isShuffle) {
            nextIndex = Math.floor(Math.random() * room.playlist.length);
        } else {
            nextIndex = (room.currentTrackIndex + 1) % room.playlist.length;
        }

        room.currentTrackIndex = nextIndex;
        const track = room.playlist[nextIndex];
        
        room.currentPlaybackState = {
            isPlaying: true,
            startTimestamp: Date.now(),
            seekPosition: 0,
            playbackRate: room.currentPlaybackState.playbackRate || 1.0,
            currentTrackName: track.name,
            duration: 0
        };

        io.to(socket.roomId).emit('load-audio-buffer', {
            trackName: track.name,
            buffer: track.arrayBuffer
        });

        broadcastPlaylist(socket.roomId);
        
        io.to(socket.roomId).emit('audio-sync-receive', {
            action: 'play',
            index: nextIndex,
            startTimestamp: room.currentPlaybackState.startTimestamp,
            seekPosition: 0,
            playbackRate: room.currentPlaybackState.playbackRate,
            trackName: track.name,
            serverTime: Date.now(),
            crossfade: room.crossfadeDuration
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

    socket.on('admin-mic-stream', (chunk) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        socket.to(socket.roomId).emit('listener-receive-mic', chunk);
    });

    socket.on('admin-mic-state', (isSpeaking) => {
        if (socket.role !== 'admin' || !socket.roomId) return;
        socket.to(socket.roomId).emit('listener-mic-ducking', isSpeaking);
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
