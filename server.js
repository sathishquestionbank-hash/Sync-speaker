const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io with permissive CORS for cloud deployment
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Connected speaker nodes state registry
const connectedNodes = new Map();
let currentChirpTxTime = null;

io.on('connection', (socket) => {
  console.log(`[Node Connected] ID: ${socket.id}`);
  
  connectedNodes.set(socket.id, {
    id: socket.id,
    delayMs: 0,
    eqPreset: 'Flat',
    volume: 1.0
  });

  io.emit('nodes_updated', Array.from(connectedNodes.values()));

  // 1. NTP-Style Time Synchronization
  socket.on('ping_sync', (data) => {
    const t1 = Date.now();
    socket.emit('pong_sync', {
      t0: data.t0,
      t1: t1,
      t2: Date.now()
    });
  });

  // 2. WebRTC Peer-to-Peer Signaling Relay
  socket.on('webrtc_signal', (data) => {
    if (data.target && connectedNodes.has(data.target)) {
      io.to(data.target).emit('webrtc_signal', {
        sender: socket.id,
        offer: data.offer,
        answer: data.answer,
        candidate: data.candidate
      });
    }
  });

  socket.on('request_peers', () => {
    const peers = Array.from(connectedNodes.keys()).filter(id => id !== socket.id);
    socket.emit('peer_list', peers);
  });

  // 3. Ultrasonic Auto-Calibration Protocol
  socket.on('master_emitted_chirp', (data) => {
    currentChirpTxTime = data.timestamp;
    socket.broadcast.emit('listen_for_chirp');
  });

  socket.on('chirp_detected', (data) => {
    if (!currentChirpTxTime) return;
    const timeOfFlightMs = Math.max(0, data.arrivalTime - currentChirpTxTime);
    const node = connectedNodes.get(socket.id);
    if (node) {
      node.delayMs = Math.round(timeOfFlightMs);
      connectedNodes.set(socket.id, node);
      socket.emit('apply_calculated_delay', { delayMs: node.delayMs });
      io.emit('nodes_updated', Array.from(connectedNodes.values()));
    }
  });

  // 4. Live DJ Mic Paging & Ducking
  socket.on('dj_paging_state', (data) => {
    socket.broadcast.emit('dj_paging_state', data);
  });

  socket.on('dj_audio_chunk', (chunk) => {
    socket.broadcast.emit('dj_audio_chunk', chunk);
  });

  // 5. DSP Equalizer & Delay Updates
  socket.on('update_node_settings', (data) => {
    const node = connectedNodes.get(socket.id);
    if (node) {
      if (data.delayMs !== undefined) node.delayMs = data.delayMs;
      if (data.eqPreset) node.eqPreset = data.eqPreset;
      connectedNodes.set(socket.id, node);
      io.emit('nodes_updated', Array.from(connectedNodes.values()));
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Node Disconnected] ID: ${socket.id}`);
    connectedNodes.delete(socket.id);
    io.emit('nodes_updated', Array.from(connectedNodes.values()));
  });
});

// Single-file delivery of the Ahuja FMX-212PRO integrated console
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sync Speaker Studio — Ahuja FMX-212PRO Console</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #151d30;
      --accent: #38bdf8;
      --green: #4ade80;
      --pink: #f472b6;
      --orange: #fb923c;
      --text: #f8fafc;
      --muted: #64748b;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 1.5rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { margin-bottom: 0.2rem; font-size: 1.8rem; }
    .subtitle { color: var(--muted); margin-bottom: 1.5rem; font-size: 0.95rem; }
    
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .card { background: var(--card); padding: 1.25rem; border-radius: 10px; border: 1px solid #1e293b; }
    
    .metric-group { display: flex; gap: 1.5rem; background: var(--card); padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .metric span { display: block; font-size: 0.75rem; color: var(--muted); text-transform: uppercase; }
    .metric strong { font-size: 1.1rem; color: var(--accent); }

    .btn {
      background: var(--accent); color: #000; border: none; padding: 0.65rem 1rem;
      font-weight: 600; border-radius: 6px; cursor: pointer; transition: 0.2s opacity; margin-right: 0.5rem; margin-bottom: 0.5rem;
    }
    .btn-pink { background: var(--pink); color: #fff; }
    .btn-green { background: var(--green); color: #000; }
    .btn-orange { background: var(--orange); color: #000; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    select, input[type="range"], input[type="file"] { width: 100%; padding: 0.5rem; background: #0f172a; color: var(--text); border: 1px solid #334155; border-radius: 6px; margin-top: 0.3rem; box-sizing: border-box; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.65rem; border-bottom: 1px solid #1e293b; font-size: 0.9rem; }
    th { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; }

    canvas { width: 100%; height: 80px; background: #090d16; border-radius: 6px; margin-top: 0.75rem; }
    
    /* Mixer Channels Layout */
    .mixer-channels { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
    .channel-strip { background: #0d1424; padding: 0.75rem; border-radius: 6px; border: 1px solid #1e293b; font-size: 0.8rem; }
    .channel-strip h4 { margin: 0 0 0.5rem 0; color: var(--accent); font-size: 0.85rem; border-bottom: 1px solid #1e293b; padding-bottom: 0.25rem; }
    .control-label { font-size: 0.7rem; color: var(--muted); margin-top: 0.4rem; display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sync Speaker Studio — Ahuja FMX-212PRO Console</h1>
    <div class="subtitle">Multi-Room Audio Engine with Integrated 12-Ch Mix Console, DSP FX, Graphic EQ & NTP Alignment</div>

    <div class="metric-group">
      <div class="metric"><span>Node ID</span><strong id="my-id">Connecting...</strong></div>
      <div class="metric"><span>NTP Clock Offset</span><strong id="clock-offset">0.00 ms</strong></div>
      <div class="metric"><span>Round Trip Time</span><strong id="rtt">0.00 ms</strong></div>
    </div>

    <!-- 1. System Controls & Media Player -->
    <div class="grid">
      <div class="card">
        <h3>1. System Engine & DJ Paging</h3>
        <button class="btn" id="btn-init">Activate Audio Engine</button>
        <button class="btn btn-pink" id="btn-dj" disabled>Hold for Live DJ Paging</button>
        <button class="btn btn-green" id="btn-chirp" disabled>Emit Ultrasonic Chirp</button>
      </div>

      <div class="card">
        <h3>2. Ahuja Media Player & Bluetooth AUX</h3>
        <label>Load MP3 Track (USB / Local Media)</label>
        <input type="file" id="media-file" accept="audio/*" disabled>
        <div style="margin-top:0.75rem;">
          <button class="btn btn-green" id="btn-play" disabled>Play</button>
          <button class="btn btn-orange" id="btn-pause" disabled>Pause</button>
        </div>
      </div>
    </div>

    <!-- 2. Ahuja 212PRO Master DSP & FX Processor -->
    <div class="grid">
      <div class="card">
        <h3>3. 24-Bit Digital Multi-FX Engine</h3>
        <label>FX Preset</label>
        <select id="fx-preset" disabled>
          <option value="Off">Bypass (Off)</option>
          <option value="HallReverb">Vocal Hall Reverb</option>
          <option value="StageDelay">Stage Echo Delay</option>
        </select>

        <label class="control-label">FX Return Level (Wet Mix)</label>
        <input type="range" id="fx-level" min="0" max="1" step="0.05" value="0.3" disabled>

        <label class="control-label">Manual Distance Delay Compensation (ms)</label>
        <input type="range" id="delay-slider" min="0" max="2000" value="0" disabled>
        <span id="delay-val" style="font-size: 0.8rem; color: var(--muted);">0 ms</span>
      </div>

      <div class="card">
        <h3>4. Master Graphic Equalizer</h3>
        <label class="control-label">Low (80 Hz)</label>
        <input type="range" id="geq-low" min="-12" max="12" value="0" step="1" disabled>
        <label class="control-label">Mid (2.5 kHz)</label>
        <input type="range" id="geq-mid" min="-12" max="12" value="0" step="1" disabled>
        <label class="control-label">High (12 kHz)</label>
        <input type="range" id="geq-high" min="-12" max="12" value="0" step="1" disabled>
      </div>
    </div>

    <!-- 3. 12-Channel Input Mixer Panel -->
    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>5. 12-Channel Input Mixer Strip</h3>
      <div class="mixer-channels" id="mixer-strips"></div>
    </div>

    <!-- 4. Real-Time Visualizer -->
    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>6. Master Output Spectrum Visualizer</h3>
      <canvas id="visualizer"></canvas>
    </div>

    <!-- 5. Node Matrix Table -->
    <div class="card">
      <h3>7. Studio Speaker Node Matrix</h3>
      <table>
        <thead>
          <tr>
            <th>Node ID</th>
            <th>Calculated Acoustic Delay</th>
            <th>EQ Profile</th>
            <th>Mesh Status</th>
          </tr>
        </thead>
        <tbody id="nodes-table"></tbody>
      </table>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();

    // Core Audio Graph
    let audioCtx, masterGain, delayNode, analyser, micStream, djMediaRecorder;
    let masterGeqLow, masterGeqMid, masterGeqHigh;
    let fxConvolver, fxDelayNode, fxGain;
    let audioElement, audioSourceNode;
    let isAudioInit = false;

    // Channel Strips (12 Channels)
    const channelNodes = [];

    // Timing Sync
    let clockOffset = 0, rtt = 0;
    const peerConnections = {};
    const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

    // DOM Elements
    const myIdEl = document.getElementById('my-id');
    const offsetEl = document.getElementById('clock-offset');
    const rttEl = document.getElementById('rtt');
    const btnInit = document.getElementById('btn-init');
    const btnDj = document.getElementById('btn-dj');
    const btnChirp = document.getElementById('btn-chirp');
    const mediaFileInput = document.getElementById('media-file');
    const btnPlay = document.getElementById('btn-play');
    const btnPause = document.getElementById('btn-pause');
    const fxPresetSelect = document.getElementById('fx-preset');
    const fxLevelSlider = document.getElementById('fx-level');
    const delaySlider = document.getElementById('delay-slider');
    const delayVal = document.getElementById('delay-val');
    const geqLowSlider = document.getElementById('geq-low');
    const geqMidSlider = document.getElementById('geq-mid');
    const geqHighSlider = document.getElementById('geq-high');
    const nodesTable = document.getElementById('nodes-table');
    const canvas = document.getElementById('visualizer');
    const canvasCtx = canvas.getContext('2d');

    // Dynamically Render 12 Mixer Channel UI Strips
    const stripsContainer = document.getElementById('mixer-strips');
    for (let i = 1; i <= 12; i++) {
      const isStereo = i >= 11;
      stripsContainer.innerHTML += \`
        <div class="channel-strip">
          <h4>\${isStereo ? 'Ch ' + i + ' (ST)' : 'Ch ' + i}</h4>
          <label class="control-label">GAIN</label>
          <input type="range" id="ch-gain-\${i}" min="0" max="2" step="0.05" value="1" disabled>
          <label class="control-label">HIGH (12k)</label>
          <input type="range" id="ch-high-\${i}" min="-12" max="12" step="1" value="0" disabled>
          <label class="control-label">MID (2.5k)</label>
          <input type="range" id="ch-mid-\${i}" min="-12" max="12" step="1" value="0" disabled>
          <label class="control-label">LOW (80Hz)</label>
          <input type="range" id="ch-low-\${i}" min="-12" max="12" step="1" value="0" disabled>
          <label class="control-label">AUX/FX SEND</label>
          <input type="range" id="ch-fx-\${i}" min="0" max="1" step="0.05" value="0" disabled>
        </div>
      \`;
    }

    // 1. NTP Time Synchronization Protocol
    function syncClock() { socket.emit('ping_sync', { t0: Date.now() }); }
    socket.on('pong_sync', (data) => {
      const t3 = Date.now();
      rtt = (t3 - data.t0) - (data.t2 - data.t1);
      clockOffset = ((data.t1 - data.t0) + (data.t2 - t3)) / 2;
      offsetEl.innerText = clockOffset.toFixed(2) + ' ms';
      rttEl.innerText = rtt.toFixed(2) + ' ms';
    });
    setInterval(syncClock, 2500);
    function getSyncedTime() { return Date.now() + clockOffset; }

    // 2. Initialize Master Audio Engine & Ahuja DSP Pipeline
    function initEngine() {
      if (isAudioInit) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx();

      // Master Output Nodes
      delayNode = audioCtx.createDelay(5.0);
      masterGain = audioCtx.createGain();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;

      // Master Graphic Equalizer (3 Band Active)
      masterGeqLow = audioCtx.createBiquadFilter();
      masterGeqLow.type = 'lowshelf';
      masterGeqLow.frequency.value = 80;

      masterGeqMid = audioCtx.createBiquadFilter();
      masterGeqMid.type = 'peaking';
      masterGeqMid.frequency.value = 2500;

      masterGeqHigh = audioCtx.createBiquadFilter();
      masterGeqHigh.type = 'highshelf';
      masterGeqHigh.frequency.value = 12000;

      // Master Digital Multi-FX Bus
      fxGain = audioCtx.createGain();
      fxGain.gain.value = 0.3;
      fxDelayNode = audioCtx.createDelay();
      fxDelayNode.delayTime.value = 0.35;

      // Synthetic Reverb Impulse Generation
      fxConvolver = audioCtx.createConvolver();
      const rate = audioCtx.sampleRate;
      const length = rate * 2.0;
      const impulse = audioCtx.createBuffer(2, length, rate);
      for (let c = 0; c < 2; c++) {
        const channelData = impulse.getChannelData(c);
        for (let i = 0; i < length; i++) {
          channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
        }
      }
      fxConvolver.buffer = impulse;

      // Connect 12 Channel DSP Architecture
      for (let i = 1; i <= 12; i++) {
        const gainNode = audioCtx.createGain();
        const highEq = audioCtx.createBiquadFilter(); highEq.type = 'highshelf'; highEq.frequency.value = 12000;
        const midEq = audioCtx.createBiquadFilter(); midEq.type = 'peaking'; midEq.frequency.value = 2500;
        const lowEq = audioCtx.createBiquadFilter(); lowEq.type = 'lowshelf'; lowEq.frequency.value = 80;
        const fxSendGain = audioCtx.createGain(); fxSendGain.gain.value = 0;

        gainNode.connect(highEq);
        highEq.connect(midEq);
        midEq.connect(lowEq);
        lowEq.connect(masterGeqLow);
        lowEq.connect(fxSendGain);
        fxSendGain.connect(fxGain);

        channelNodes[i] = { gainNode, highEq, midEq, lowEq, fxSendGain };

        // Attach Strip Event Listeners
        document.getElementById(\`ch-gain-\${i}\`).addEventListener('input', e => gainNode.gain.value = parseFloat(e.target.value));
        document.getElementById(\`ch-high-\${i}\`).addEventListener('input', e => highEq.gain.value = parseFloat(e.target.value));
        document.getElementById(\`ch-mid-\${i}\`).addEventListener('input', e => midEq.gain.value = parseFloat(e.target.value));
        document.getElementById(\`ch-low-\${i}\`).addEventListener('input', e => lowEq.gain.value = parseFloat(e.target.value));
        document.getElementById(\`ch-fx-\${i}\`).addEventListener('input', e => fxSendGain.gain.value = parseFloat(e.target.value));
        document.querySelectorAll(\`#ch-gain-\${i}, #ch-high-\${i}, #ch-mid-\${i}, #ch-low-\${i}, #ch-fx-\${i}\`).forEach(el => el.disabled = false);
      }

      // FX Bus Routing -> Master GEQ
      fxGain.connect(masterGeqLow);

      // Route Master GEQ -> Delay Node -> Master Volume Gain -> Analyser -> Output
      masterGeqLow.connect(masterGeqMid);
      masterGeqMid.connect(masterGeqHigh);
      masterGeqHigh.connect(delayNode);
      delayNode.connect(masterGain);
      masterGain.connect(analyser);
      analyser.connect(audioCtx.destination);

      isAudioInit = true;
      btnInit.disabled = true;
      btnInit.innerText = "Engine Active";
      btnDj.disabled = false;
      btnChirp.disabled = false;
      mediaFileInput.disabled = false;
      fxPresetSelect.disabled = false;
      fxLevelSlider.disabled = false;
      delaySlider.disabled = false;
      geqLowSlider.disabled = false;
      geqMidSlider.disabled = false;
      geqHighSlider.disabled = false;

      drawVisualizer();
      socket.emit('request_peers');
    }
    btnInit.addEventListener('click', initEngine);

    // 3. Media Player Logic (Connects to Ch 11/12 Stereo AUX)
    mediaFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file || !isAudioInit) return;
      if (audioElement) audioElement.pause();
      
      audioElement = new Audio(URL.createObjectURL(file));
      audioSourceNode = audioCtx.createMediaElementSource(audioElement);
      audioSourceNode.connect(channelNodes[11].gainNode);
      btnPlay.disabled = false;
      btnPause.disabled = false;
    });
    btnPlay.addEventListener('click', () => audioElement && audioElement.play());
    btnPause.addEventListener('click', () => audioElement && audioElement.pause());

    // 4. Master Graphic EQ & FX Routing Controls
    geqLowSlider.addEventListener('input', e => masterGeqLow.gain.value = parseFloat(e.target.value));
    geqMidSlider.addEventListener('input', e => masterGeqMid.gain.value = parseFloat(e.target.value));
    geqHighSlider.addEventListener('input', e => masterGeqHigh.gain.value = parseFloat(e.target.value));

    fxLevelSlider.addEventListener('input', e => fxGain.gain.value = parseFloat(e.target.value));
    fxPresetSelect.addEventListener('change', (e) => {
      const preset = e.target.value;
      fxGain.disconnect();
      if (preset === 'HallReverb') fxGain.connect(fxConvolver).connect(masterGeqLow);
      else if (preset === 'StageDelay') fxGain.connect(fxDelayNode).connect(masterGeqLow);
      else fxGain.connect(masterGeqLow);
    });

    delaySlider.addEventListener('input', (e) => {
      const ms = e.target.value;
      delayVal.innerText = ms + ' ms';
      if (delayNode) delayNode.delayTime.setValueAtTime(ms / 1000, audioCtx.currentTime);
      socket.emit('update_node_settings', { delayMs: parseInt(ms) });
    });

    // 5. Live DJ Mic Paging (Routed to Channel 1 Mic)
    btnDj.addEventListener('mousedown', startDjPaging);
    btnDj.addEventListener('mouseup', stopDjPaging);
    async function startDjPaging() {
      if (!isAudioInit) return;
      socket.emit('dj_paging_state', { active: true });
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(channelNodes[1].gainNode);
      djMediaRecorder = new MediaRecorder(micStream);
      djMediaRecorder.ondataavailable = (e) => socket.emit('dj_audio_chunk', e.data);
      djMediaRecorder.start(100);
    }
    function stopDjPaging() {
      if (djMediaRecorder && djMediaRecorder.state !== 'inactive') {
        djMediaRecorder.stop();
        micStream.getTracks().forEach(t => t.stop());
        socket.emit('dj_paging_state', { active: false });
      }
    }
    socket.on('dj_paging_state', (data) => {
      if (masterGain) masterGain.gain.setTargetAtTime(data.active ? 0.2 : 1.0, audioCtx.currentTime, 0.1);
    });

    // 6. Ultrasonic Auto-Calibration Protocol
    btnChirp.addEventListener('click', () => {
      if (!isAudioInit) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(19000, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.8, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + 0.05);
      socket.emit('master_emitted_chirp', { timestamp: getSyncedTime() });
    });

    socket.on('listen_for_chirp', async () => {
      if (!isAudioInit) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const micSource = audioCtx.createMediaStreamSource(stream);
        const micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 2048;
        micSource.connect(micAnalyser);
        const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);
        const targetBin = Math.round(19000 / (audioCtx.sampleRate / micAnalyser.fftSize));

        const start = Date.now();
        function detect() {
          micAnalyser.getByteFrequencyData(dataArray);
          if (dataArray[targetBin] > 180) {
            socket.emit('chirp_detected', { arrivalTime: getSyncedTime() });
            stream.getTracks().forEach(t => t.stop());
          } else if (Date.now() - start < 3000) {
            requestAnimationFrame(detect);
          } else { stream.getTracks().forEach(t => t.stop()); }
        }
        detect();
      } catch (err) {}
    });

    socket.on('apply_calculated_delay', (data) => {
      if (delayNode) {
        delaySlider.value = data.delayMs;
        delayVal.innerText = data.delayMs + ' ms';
        delayNode.delayTime.setTargetAtTime(data.delayMs / 1000, audioCtx.currentTime, 0.1);
      }
    });

    // 7. WebRTC P2P Signaling Relay
    socket.on('peer_list', (peers) => peers.forEach(id => initPeer(id, true)));
    function initPeer(peerId, isInitiator) {
      if (peerConnections[peerId]) return peerConnections[peerId];
      const pc = new RTCPeerConnection(rtcConfig);
      peerConnections[peerId] = pc;
      pc.onicecandidate = (e) => e.candidate && socket.emit('webrtc_signal', { target: peerId, candidate: e.candidate });
      pc.ontrack = (e) => isAudioInit && audioCtx.createMediaStreamSource(e.streams[0]).connect(channelNodes[2].gainNode);
      if (isInitiator) {
        pc.createOffer().then(o => { pc.setLocalDescription(o); socket.emit('webrtc_signal', { target: peerId, offer: o }); });
      }
      return pc;
    }
    socket.on('webrtc_signal', async (data) => {
      let pc = peerConnections[data.sender];
      if (data.offer) {
        pc = initPeer(data.sender, false);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const a = await pc.createAnswer();
        await pc.setLocalDescription(a);
        socket.emit('webrtc_signal', { target: data.sender, answer: a });
      } else if (data.answer && pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      else if (data.candidate && pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    });

    // 8. Visualizer Loop & UI Updates
    function drawVisualizer() {
      requestAnimationFrame(drawVisualizer);
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(dataArray);

      canvasCtx.fillStyle = '#090d16';
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        canvasCtx.fillStyle = '#38bdf8';
        canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    }

    socket.on('connect', () => { myIdEl.innerText = socket.id; });
    socket.on('nodes_updated', (nodes) => {
      nodesTable.innerHTML = nodes.map(n => \`
        <tr>
          <td>\${n.id} \${n.id === socket.id ? '<strong>(You)</strong>' : ''}</td>
          <td>\${n.delayMs} ms</td>
          <td>\${n.eqPreset}</td>
          <td><span style="color: var(--green)">Active</span></td>
        </tr>
      \`).join('');
    });
  </script>
</body>
</html>
  `);
});

// Render automatically assigns PORT via environment variable
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Sync Speaker Studio] Running on port ${PORT}`);
});
