const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Enable CORS for cross-origin connections
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from the ROOT directory (where index.html lives)
app.use(express.static(__dirname));

// Serve index.html when users hit the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io event handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('play', (data) => {
    socket.broadcast.emit('play', data);
  });

  socket.on('pause', (data) => {
    socket.broadcast.emit('pause', data);
  });

  socket.on('seek', (data) => {
    socket.broadcast.emit('seek', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Bind to process.env.PORT and 0.0.0.0 for free cloud hosting platforms
const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
