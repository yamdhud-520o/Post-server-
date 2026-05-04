const express = require('express');
const multer = require('multer');
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Error handling for uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '.txt');
    }
});

const upload = multer({ storage: storage });

const wss = new WebSocket.Server({ noServer: true });
let activeTasks = new Map();
let wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => {
        wsClients.delete(ws);
    });
});

function broadcastLog(message, type = 'info') {
    const logEntry = {
        timestamp: new Date().toLocaleTimeString(),
        message: message,
        type: type
    };
    
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(logEntry));
        }
    });
}

async function makeFacebookRequest(url, method = 'GET', data = null, cookies = null) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        };

        if (cookies) {
            headers['Cookie'] = cookies;
        }

        const response = await axios({
            method: method,
            url: url,
            headers: headers,
            data: data,
            timeout: 30000
        });

        return { success: true, data: response.data };
    } catch (error) {
        return { 
            success: false, 
            error: error.response?.data?.error?.message || error.message 
        };
    }
}

async function validateCookies(cookies) {
    try {
        const url = 'https://graph.facebook.com/v18.0/me';
        const result = await makeFacebookRequest(url, 'GET', null, cookies);
        return result.success;
    } catch (error) {
        return false;
    }
}

async function postComment(postId, message, cookies) {
    const url = `https://graph.facebook.com/v18.0/${postId}/comments`;
    const data = { message: message };
    return await makeFacebookRequest(url, 'POST', data, cookies);
}

async function postReply(commentId, message, cookies) {
    const url = `https://graph.facebook.com/v18.0/${commentId}/comments`;
    const data = { message: message };
    return await makeFacebookRequest(url, 'POST', data, cookies);
}

async function executeTask(taskId, taskConfig, messages) {
    const { toolType, targetId, cookies, delay, haterName, lastName } = taskConfig;
    
    broadcastLog(`🚀 Task started: ${toolType === 'comment' ? 'Comment Tool' : 'Reply Tool'}`, 'success');
    broadcastLog(`🎯 Target ID: ${targetId}`, 'info');
    broadcastLog(`⏱️ Delay: ${delay} seconds`, 'info');
    broadcastLog(`📝 Total messages: ${messages.length}`, 'info');
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < messages.length; i++) {
        if (!activeTasks.has(taskId)) {
            broadcastLog(`🛑 Task stopped by user`, 'warning');
            break;
        }
        
        const prefixedMessage = `${haterName} ${lastName}: ${messages[i]}`;
        broadcastLog(`📤 Sending ${i + 1}/${messages.length}: "${prefixedMessage.substring(0, 50)}..."`, 'info');
        
        let result;
        if (toolType === 'comment') {
            result = await postComment(targetId, prefixedMessage, cookies);
        } else {
            result = await postReply(targetId, prefixedMessage, cookies);
        }
        
        if (result.success) {
            successCount++;
            broadcastLog(`✅ Message ${i + 1} sent!`, 'success');
        } else {
            failCount++;
            broadcastLog(`❌ Failed: ${result.error}`, 'error');
        }
        
        if (i < messages.length - 1 && activeTasks.has(taskId)) {
            broadcastLog(`⏳ Waiting ${delay} seconds...`, 'info');
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }
    
    broadcastLog(`📊 Completed! Success: ${successCount}, Failed: ${failCount}`, 'success');
    activeTasks.delete(taskId);
}

app.post('/api/upload-messages', upload.single('messagesFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    try {
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        const messages = fileContent.split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => line.trim());
        
        res.json({ success: true, messages: messages });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/start-task', async (req, res) => {
    try {
        const { toolType, targetId, cookies, delay, haterName, lastName, messages } = req.body;
        
        if (!toolType || !targetId || !cookies || !delay || !haterName || !lastName || !messages) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        broadcastLog('🔍 Validating cookies...', 'info');
        const isValid = await validateCookies(cookies);
        
        if (!isValid) {
            broadcastLog('❌ Invalid cookies!', 'error');
            return res.status(401).json({ error: 'Invalid cookies' });
        }
        
        broadcastLog('✅ Cookies validated!', 'success');
        
        const taskId = uuidv4();
        const taskConfig = { toolType, targetId, cookies, delay: parseInt(delay), haterName, lastName };
        
        activeTasks.set(taskId, { config: taskConfig, messages: messages });
        executeTask(taskId, taskConfig, messages).catch(error => {
            broadcastLog(`❌ Error: ${error.message}`, 'error');
            activeTasks.delete(taskId);
        });
        
        res.json({ success: true, taskId: taskId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stop-task', (req, res) => {
    try {
        const { taskId } = req.body;
        
        if (taskId && activeTasks.has(taskId)) {
            activeTasks.delete(taskId);
            broadcastLog(`🛑 Task stopped`, 'warning');
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Task not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tasks', (req, res) => {
    try {
        const tasks = Array.from(activeTasks.keys());
        res.json({ tasks: tasks });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// HTML Frontend
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FB AUTOMATOR | AYAZ DON</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: radial-gradient(circle at 0% 0%, #1a0b2e 0%, #0f0c29 50%, #1a1a2e 100%);
            min-height: 100vh;
            padding: 30px 20px;
            position: relative;
            overflow-x: hidden;
        }

        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: 
                repeating-linear-gradient(90deg, rgba(139, 92, 246, 0.03) 0px, rgba(139, 92, 246, 0.03) 1px, transparent 1px, transparent 100px),
                repeating-linear-gradient(0deg, rgba(139, 92, 246, 0.03) 0px, rgba(139, 92, 246, 0.03) 1px, transparent 1px, transparent 100px);
            pointer-events: none;
            z-index: 0;
        }

        .container {
            max-width: 750px;
            margin: 0 auto;
            position: relative;
            z-index: 1;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
            animation: fadeInDown 0.6s ease-out;
        }

        @keyframes fadeInDown {
            from {
                opacity: 0;
                transform: translateY(-30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .header h1 {
            background: linear-gradient(135deg, #fff 0%, #c4b5fd 50%, #a78bfa 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-size: 32px;
            font-weight: 800;
            letter-spacing: -0.5px;
            margin-bottom: 10px;
        }

        .header-links a {
            color: #a78bfa;
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            padding: 5px 10px;
            border-radius: 8px;
            background: rgba(139, 92, 246, 0.1);
        }

        .card {
            background: rgba(20, 17, 45, 0.8);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 30px;
            border: 1px solid rgba(139, 92, 246, 0.2);
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            animation: fadeInUp 0.6s ease-out;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .tool-toggle {
            display: flex;
            gap: 15px;
            margin-bottom: 30px;
        }

        .tool-btn {
            flex: 1;
            padding: 14px;
            background: rgba(30, 27, 58, 0.6);
            border: 1px solid rgba(139, 92, 246, 0.3);
            color: #a0aec0;
            border-radius: 16px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }

        .tool-btn.active {
            background: linear-gradient(135deg, #8b5cf6, #6d28d9);
            border-color: #a78bfa;
            color: white;
            box-shadow: 0 10px 20px -5px rgba(139, 92, 246, 0.4);
        }

        .form-content {
            display: flex;
            flex-direction: column;
            gap: 22px;
        }

        .input-field {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .input-field label {
            color: #c4b5fd;
            font-size: 14px;
            font-weight: 600;
        }

        .input-field textarea,
        .input-field input {
            background: rgba(10, 8, 25, 0.8);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 14px;
            padding: 12px 16px;
            color: #fff;
            font-size: 14px;
            font-family: 'Inter', monospace;
        }

        .input-field textarea {
            resize: vertical;
            min-height: 100px;
        }

        .input-field textarea:focus,
        .input-field input:focus {
            outline: none;
            border-color: #8b5cf6;
            box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.1);
        }

        .row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 18px;
        }

        .file-input-wrapper {
            display: flex;
            align-items: center;
            gap: 12px;
            background: rgba(10, 8, 25, 0.8);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 14px;
            padding: 8px 12px;
        }

        .file-btn {
            background: linear-gradient(135deg, #6b46c1, #553c9a);
            color: white;
            border: none;
            padding: 8px 24px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
        }

        .file-name {
            color: #9ca3af;
            font-size: 13px;
            flex: 1;
        }

        .action-buttons {
            display: flex;
            gap: 15px;
            margin-top: 25px;
            margin-bottom: 25px;
        }

        .action-btn {
            flex: 1;
            padding: 14px;
            border: none;
            border-radius: 14px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }

        .start-btn {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
        }

        .stop-btn {
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
        }

        .view-btn {
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: white;
        }

        .action-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .console-section {
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 20px;
            border: 1px solid rgba(139, 92, 246, 0.2);
        }

        .console-title {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            color: #c4b5fd;
            font-weight: 600;
        }

        .clear-console {
            background: rgba(139, 92, 246, 0.2);
            border: 1px solid rgba(139, 92, 246, 0.3);
            color: #c4b5fd;
            padding: 5px 18px;
            border-radius: 10px;
            cursor: pointer;
        }

        .console-output {
            background: rgba(0, 0, 0, 0.6);
            border-radius: 14px;
            padding: 15px;
            height: 260px;
            overflow-y: auto;
            font-family: 'Courier New', monospace;
            font-size: 12px;
        }

        .log-line {
            padding: 8px 0;
            border-bottom: 1px solid rgba(139, 92, 246, 0.1);
        }

        .log-line .time {
            color: #6b7280;
            margin-right: 12px;
        }

        .log-line.info { color: #60a5fa; }
        .log-line.success { color: #34d399; }
        .log-line.error { color: #f87171; }
        .log-line.warning { color: #fbbf24; }

        @media (max-width: 600px) {
            .tool-toggle, .row, .action-buttons { flex-direction: column; }
            .row { grid-template-columns: 1fr; }
            .header h1 { font-size: 24px; }
            .card { padding: 20px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 FB AUTOMATOR | AYAZ DON</h1>
            <div class="header-links">
                <a href="#" target="_blank">http://fi11.bot-hosting.net:21132</a>
            </div>
        </div>

        <div class="card">
            <div class="tool-toggle">
                <button class="tool-btn active" id="commentToolBtn">💬 Comment Tool</button>
                <button class="tool-btn" id="replyToolBtn">↩️ Reply Tool</button>
            </div>

            <div class="form-content">
                <div class="input-field">
                    <label>📋 Paste Cookies</label>
                    <textarea id="cookies" placeholder="c_user=123456789; xs=1234567890; ..."></textarea>
                </div>

                <div class="input-field">
                    <label id="targetLabel">📌 Facebook Post UID</label>
                    <input type="text" id="targetId" placeholder="Enter Post UID">
                </div>

                <div class="row">
                    <div class="input-field">
                        <label>👤 Hater Name</label>
                        <input type="text" id="haterName" placeholder="Hater Name">
                    </div>
                    <div class="input-field">
                        <label>📝 Last Name</label>
                        <input type="text" id="lastName" placeholder="Last Name">
                    </div>
                </div>

                <div class="input-field">
                    <label>📁 Upload .txt messages</label>
                    <div class="file-input-wrapper">
                        <input type="file" id="messagesFile" accept=".txt" style="display: none;">
                        <button class="file-btn" id="fileSelectBtn">Choose File</button>
                        <span id="fileName" class="file-name">No file chosen</span>
                    </div>
                </div>

                <div class="input-field">
                    <label>⏱️ Delay (seconds)</label>
                    <input type="number" id="delay" value="51" min="1">
                </div>
            </div>
        </div>

        <div class="action-buttons">
            <button class="action-btn start-btn" id="startBtn">▶ Start</button>
            <button class="action-btn stop-btn" id="stopBtn" disabled>⏹️ Stop</button>
            <button class="action-btn view-btn" id="viewTaskBtn">📋 View Task</button>
        </div>

        <div class="console-section">
            <div class="console-title">
                <span>📺 Live Console</span>
                <button class="clear-console" id="clearConsoleBtn">Clear</button>
            </div>
            <div class="console-output" id="liveConsole">
                <div class="log-line info"><span class="time">[System]</span> 🚀 FB Automator is ready!</div>
            </div>
        </div>
    </div>

    <script>
        let currentTaskId = null;
        let uploadedMessages = null;
        let currentTool = 'comment';
        let ws = null;

        const commentBtn = document.getElementById('commentToolBtn');
        const replyBtn = document.getElementById('replyToolBtn');
        const targetLabel = document.getElementById('targetLabel');
        const targetInput = document.getElementById('targetId');

        commentBtn.onclick = () => {
            commentBtn.classList.add('active');
            replyBtn.classList.remove('active');
            currentTool = 'comment';
            targetLabel.innerHTML = '📌 Facebook Post UID';
            targetInput.placeholder = 'Enter Post UID';
            addLog('Switched to Comment Tool', 'info');
        };

        replyBtn.onclick = () => {
            replyBtn.classList.add('active');
            commentBtn.classList.remove('active');
            currentTool = 'reply';
            targetLabel.innerHTML = '💬 Facebook Comment UID';
            targetInput.placeholder = 'Enter Comment UID';
            addLog('Switched to Reply Tool', 'info');
        };

        document.getElementById('fileSelectBtn').onclick = () => {
            document.getElementById('messagesFile').click();
        };

        document.getElementById('messagesFile').onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                document.getElementById('fileName').textContent = file.name;
                const formData = new FormData();
                formData.append('messagesFile', file);
                addLog('📤 Uploading ' + file.name + '...', 'info');
                
                try {
                    const res = await fetch('/api/upload-messages', { method: 'POST', body: formData });
                    const result = await res.json();
                    if (result.success) {
                        uploadedMessages = result.messages;
                        addLog('✅ Loaded ' + uploadedMessages.length + ' messages', 'success');
                    } else {
                        addLog('❌ Upload failed', 'error');
                    }
                } catch (err) {
                    addLog('❌ Error: ' + err.message, 'error');
                }
            }
        };

        function initWebSocket() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + location.host);
            ws.onopen = () => addLog('🔌 WebSocket connected!', 'success');
            ws.onmessage = (event) => {
                const log = JSON.parse(event.data);
                addLog(log.message, log.type);
            };
            ws.onclose = () => setTimeout(initWebSocket, 3000);
        }

        function addLog(message, type = 'info') {
            const consoleDiv = document.getElementById('liveConsole');
            const logLine = document.createElement('div');
            logLine.className = 'log-line ' + type;
            const time = new Date().toLocaleTimeString();
            logLine.innerHTML = '<span class="time">[' + time + ']</span> ' + message;
            consoleDiv.appendChild(logLine);
            logLine.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        document.getElementById('clearConsoleBtn').onclick = () => {
            document.getElementById('liveConsole').innerHTML = '';
            addLog('Console cleared', 'info');
        };

        document.getElementById('startBtn').onclick = async () => {
            const cookies = document.getElementById('cookies').value.trim();
            const targetId = document.getElementById('targetId').value.trim();
            const haterName = document.getElementById('haterName').value.trim();
            const lastName = document.getElementById('lastName').value.trim();
            const delay = document.getElementById('delay').value;

            if (!cookies) { addLog('❌ Paste cookies', 'error'); return; }
            if (!targetId) { addLog('❌ Enter target ID', 'error'); return; }
            if (!haterName || !lastName) { addLog('❌ Enter names', 'error'); return; }
            if (!uploadedMessages) { addLog('❌ Upload file first', 'error'); return; }

            const taskData = { toolType: currentTool, targetId, cookies, delay: parseInt(delay), haterName, lastName, messages: uploadedMessages };
            
            addLog('🚀 Starting task...', 'info');
            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;

            try {
                const res = await fetch('/api/start-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskData) });
                const result = await res.json();
                if (result.success) {
                    currentTaskId = result.taskId;
                    addLog('✅ Task started! ID: ' + currentTaskId, 'success');
                } else {
                    addLog('❌ Failed: ' + result.error, 'error');
                    document.getElementById('startBtn').disabled = false;
                    document.getElementById('stopBtn').disabled = true;
                }
            } catch (err) {
                addLog('❌ Error: ' + err.message, 'error');
                document.getElementById('startBtn').disabled = false;
                document.getElementById('stopBtn').disabled = true;
            }
        };

        document.getElementById('stopBtn').onclick = async () => {
            if (!currentTaskId) return;
            addLog('🛑 Stopping...', 'warning');
            try {
                await fetch('/api/stop-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: currentTaskId }) });
                addLog('✅ Stopped', 'success');
            } catch (err) {
                addLog('❌ Error: ' + err.message, 'error');
            }
            document.getElementById('startBtn').disabled = false;
            document.getElementById('stopBtn').disabled = true;
            currentTaskId = null;
        };

        document.getElementById('viewTaskBtn').onclick = async () => {
            try {
                const res = await fetch('/api/tasks');
                const result = await res.json();
                if (result.tasks.length === 0) addLog('No active tasks', 'info');
                else addLog('Active tasks: ' + result.tasks.join(', '), 'info');
            } catch (err) {
                addLog('Error: ' + err.message, 'error');
            }
        };

        initWebSocket();
        addLog('💡 System ready! Configure and start automation.', 'success');
    </script>
</body>
</html>
    `);
});

// Clean up old files
setInterval(() => {
    fs.readdir(uploadsDir, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(uploadsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > 3600000) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}, 3600000);

const server = app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 WebSocket ready for live updates`);
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});
