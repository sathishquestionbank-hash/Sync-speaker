const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static frontend files from 'public' folder
app.use(express.static(__dirname));

// Store active Admin socket IDs (Max 2)
let connectedAdmins = new Set();

io.on('connection', (socket) => {
    console.log(`[Connected] Device ID: ${socket.id}`);

    // Role Assignment
    socket.on('register-role', (requestedRole) => {
        if (requestedRole === 'admin') {
            if (connectedAdmins.size < 2) {
                connectedAdmins.add(socket.id);
                socket.role = 'admin';
                socket.emit('role-assigned', { role: 'admin', count: connectedAdmins.size });
                console.log(`[Role] ${socket.id} assigned as ADMIN (${connectedAdmins.size}/2 active)`);
            } else {
                socket.role = 'listener';
                socket.emit('role-assigned', { 
                    role: 'listener', 
                    message: 'Admin slots full (Max 2). Connected as Listener.' 
                });
                console.log(`[Role] ${socket.id} admin request rejected. Assigned LISTENER.`);
            }
        } else {
            socket.role = 'listener';
            socket.emit('role-assigned', { role: 'listener' });
            console.log(`[Role] ${socket.id} assigned as LISTENER`);
        }

        // Broadcast stats update to all connected clients
        io.emit('stats-update', {
            totalDevices: io.engine.clientsCount,
            adminCount: connectedAdmins.size
        });
    });

    // Handle audio sync events triggered by Admins
    socket.on('sync-action', (data) => {
        if (socket.role !== 'admin') {
            console.log(`[Blocked] Unauthorized sync attempt by non-admin: ${socket.id}`);
            return;
        }
        // Broadcast sync signal to all listeners
        socket.broadcast.emit('sync-receive', data);
        console.log(`[Sync Sent] Admin ${socket.id}:`, data);
    });

    socket.on('disconnect', () => {
        if (socket.role === 'admin') {
            connectedAdmins.delete(socket.id);
            console.log(`[Disconnect] Admin left (${connectedAdmins.size}/2 active)`);
        } else {
            console.log(`[Disconnect] Listener left`);
        }

        io.emit('stats-update', {
            totalDevices: io.engine.clientsCount,
            adminCount: connectedAdmins.size
        });
    });
});

// Cloud platform environment port fallback
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sync Speaker Studio running on port ${PORT}`);
});