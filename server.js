const express = require('express');
const multer = require('multer');
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
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

// WebSocket server for live console updates
const wss = new WebSocket.Server({ noServer: true });
let activeTasks = new Map();
let wsClients = new Set();

// Store connected WebSocket clients
wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => {
        wsClients.delete(ws);
    });
});

// Function to broadcast logs to all connected clients
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

// Function to make Facebook API request
async function makeFacebookRequest(url, method = 'GET', data = null, cookies = null) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Host': 'graph.facebook.com',
            'Origin': 'https://www.facebook.com',
            'Referer': 'https://www.facebook.com/'
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
        console.error('Facebook API Error:', error.response?.data || error.message);
        return { 
            success: false, 
            error: error.response?.data?.error?.message || error.message 
        };
    }
}

// Function to validate cookies
async function validateCookies(cookies) {
    const url = 'https://graph.facebook.com/v18.0/me';
    const result = await makeFacebookRequest(url, 'GET', null, cookies);
    return result.success;
}

// Function to post a comment
async function postComment(postId, message, cookies) {
    const url = `https://graph.facebook.com/v18.0/${postId}/comments`;
    const data = { message: message };
    return await makeFacebookRequest(url, 'POST', data, cookies);
}

// Function to post a reply
async function postReply(commentId, message, cookies) {
    const url = `https://graph.facebook.com/v18.0/${commentId}/comments`;
    const data = { message: message };
    return await makeFacebookRequest(url, 'POST', data, cookies);
}

// Task execution function
async function executeTask(taskId, taskConfig, messages) {
    const { toolType, targetId, cookies, delay, haterName, lastName } = taskConfig;
    
    broadcastLog(`🚀 Task started: ${toolType === 'comment' ? 'Comment Tool' : 'Reply Tool'}`, 'success');
    broadcastLog(`🎯 Target ${toolType === 'comment' ? 'Post' : 'Comment'} ID: ${targetId}`, 'info');
    broadcastLog(`⏱️ Delay between actions: ${delay} seconds`, 'info');
    broadcastLog(`📝 Total messages to send: ${messages.length}`, 'info');
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < messages.length; i++) {
        if (!activeTasks.has(taskId)) {
            broadcastLog(`🛑 Task stopped by user`, 'warning');
            break;
        }
        
        const prefixedMessage = `${haterName} ${lastName}: ${messages[i]}`;
        
        broadcastLog(`📤 Sending message ${i + 1}/${messages.length}: "${prefixedMessage.substring(0, 50)}..."`, 'info');
        
        let result;
        if (toolType === 'comment') {
            result = await postComment(targetId, prefixedMessage, cookies);
        } else {
            result = await postReply(targetId, prefixedMessage, cookies);
        }
        
        if (result.success) {
            successCount++;
            broadcastLog(`✅ Message ${i + 1} sent successfully!`, 'success');
        } else {
            failCount++;
            broadcastLog(`❌ Failed to send message ${i + 1}: ${result.error}`, 'error');
        }
        
        if (i < messages.length - 1 && activeTasks.has(taskId)) {
            broadcastLog(`⏳ Waiting ${delay} seconds before next message...`, 'info');
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }
    
    broadcastLog(`📊 Task completed! Success: ${successCount}, Failed: ${failCount}`, 'success');
    activeTasks.delete(taskId);
}

// API endpoint to upload messages file
app.post('/api/upload-messages', upload.single('messagesFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    try {
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        const messages = fileContent.split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => line.trim());
        
        res.json({
            success: true,
            messages: messages,
            filePath: req.file.path
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to start task
app.post('/api/start-task', async (req, res) => {
    const { toolType, targetId, cookies, delay, haterName, lastName, messages } = req.body;
    
    if (!toolType || !targetId || !cookies || !delay || !haterName || !lastName || !messages) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'No messages to send' });
    }
    
    broadcastLog('🔍 Validating Facebook cookies...', 'info');
    const isValid = await validateCookies(cookies);
    
    if (!isValid) {
        broadcastLog('❌ Invalid or expired cookies!', 'error');
        return res.status(401).json({ error: 'Invalid or expired cookies' });
    }
    
    broadcastLog('✅ Cookies validated successfully!', 'success');
    
    const taskId = uuidv4();
    const taskConfig = { toolType, targetId, cookies, delay: parseInt(delay), haterName, lastName };
    
    activeTasks.set(taskId, { config: taskConfig, messages: messages });
    
    executeTask(taskId, taskConfig, messages).catch(error => {
        broadcastLog(`❌ Task error: ${error.message}`, 'error');
        activeTasks.delete(taskId);
    });
    
    res.json({ success: true, taskId: taskId, message: 'Task started successfully' });
});

// API endpoint to stop task
app.post('/api/stop-task', (req, res) => {
    const { taskId } = req.body;
    
    if (taskId && activeTasks.has(taskId)) {
        activeTasks.delete(taskId);
        broadcastLog(`🛑 Task stopped by user request`, 'warning');
        res.json({ success: true, message: 'Task stopped successfully' });
    } else {
        res.status(404).json({ error: 'Task not found' });
    }
});

// API endpoint to get active tasks
app.get('/api/tasks', (req, res) => {
    const tasks = Array.from(activeTasks.keys());
    res.json({ tasks: tasks });
});

// Clean up uploads periodically
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

// Serve HTML (embedded in server.js)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FB AUTOMATOR | AYAZ DON</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Arial', sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 700px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            margin-bottom: 25px;
        }

        .header h1 {
            color: #fff;
            font-size: 28px;
            font-weight: 700;
            text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            margin-bottom: 8px;
        }

        .header-links a {
            color: #a78bfa;
            text-decoration: none;
            font-size: 13px;
        }

        .header-links a:hover {
            text-decoration: underline;
        }

        .card {
            background: rgba(30, 27, 58, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 25px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(139, 92, 246, 0.3);
        }

        .tool-toggle {
            display: flex;
            gap: 15px;
            margin-bottom: 25px;
        }

        .tool-btn {
            flex: 1;
            padding: 12px;
            background: rgba(45, 41, 78, 0.8);
            border: 1px solid rgba(139, 92, 246, 0.3);
            color: #d1d5db;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }

        .tool-btn:hover {
            background: rgba(69, 63, 115, 0.8);
        }

        .tool-btn.active {
            background: linear-gradient(135deg, #8b5cf6, #6d28d9);
            border-color: #a78bfa;
            color: white;
        }

        .form-content {
            display: flex;
            flex-direction: column;
            gap: 20px;
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
            background: rgba(20, 17, 45, 0.9);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 12px;
            padding: 12px 15px;
            color: #fff;
            font-size: 14px;
            font-family: inherit;
        }

        .input-field textarea {
            resize: vertical;
            min-height: 100px;
        }

        .input-field textarea:focus,
        .input-field input:focus {
            outline: none;
            border-color: #8b5cf6;
        }

        .row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }

        .file-input-wrapper {
            display: flex;
            align-items: center;
            gap: 12px;
            background: rgba(20, 17, 45, 0.9);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 12px;
            padding: 8px 12px;
        }

        .file-btn {
            background: linear-gradient(135deg, #6b46c1, #553c9a);
            color: white;
            border: none;
            padding: 8px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
        }

        .file-btn:hover {
            background: linear-gradient(135deg, #7c5ac9, #6b46c1);
        }

        .file-name {
            color: #9ca3af;
            font-size: 13px;
            flex: 1;
        }

        .action-buttons {
            display: flex;
            gap: 15px;
            margin-top: 20px;
            margin-bottom: 20px;
        }

        .action-btn {
            flex: 1;
            padding: 14px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
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

        .action-btn:hover:not(:disabled) {
            transform: translateY(-2px);
        }

        .action-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .console-section {
            background: rgba(0, 0, 0, 0.4);
            border-radius: 16px;
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
            border: 1px solid rgba(139, 92, 246, 0.4);
            color: #c4b5fd;
            padding: 5px 15px;
            border-radius: 8px;
            cursor: pointer;
        }

        .console-output {
            background: rgba(0, 0, 0, 0.6);
            border-radius: 12px;
            padding: 15px;
            height: 250px;
            overflow-y: auto;
            font-family: 'Courier New', monospace;
            font-size: 12px;
        }

        .log-line {
            padding: 6px 0;
            border-bottom: 1px solid rgba(139, 92, 246, 0.1);
        }

        .log-line .time {
            color: #6b7280;
            margin-right: 10px;
        }

        .log-line.info { color: #60a5fa; }
        .log-line.success { color: #34d399; }
        .log-line.error { color: #f87171; }
        .log-line.warning { color: #fbbf24; }

        @media (max-width: 600px) {
            .tool-toggle, .row, .action-buttons { flex-direction: column; }
            .row { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>FB AUTOMATOR | AYAZ DON</h1>
            <div class="header-links">
                <a href="http://fi11.bot-hosting.net:21132" target="_blank">http://fi11.bot-hosting.net:21132</a>
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
                <div class="log-line info"><span class="time">[System]</span> Ready to automate...</div>
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
                addLog('Uploading ' + file.name + '...', 'info');
                try {
                    const res = await fetch('/api/upload-messages', { method: 'POST', body: formData });
                    const result = await res.json();
                    if (result.success) {
                        uploadedMessages = result.messages;
                        addLog('✅ Loaded ' + uploadedMessages.length + ' messages', 'success');
                    } else {
                        addLog('❌ Upload failed', 'error');
                    }
                } catch(err) {
                    addLog('❌ Error: ' + err.message, 'error');
                }
            }
        };

        function initWebSocket() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + location.host);
            ws.onopen = () => addLog('WebSocket connected!', 'success');
            ws.onmessage = (event) => {
                const log = JSON.parse(event.data);
                addLog(log.message, log.type);
            };
            ws.onerror = () => addLog('WebSocket error', 'error');
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

            if (!cookies) { addLog('❌ Please paste cookies', 'error'); return; }
            if (!targetId) { addLog('❌ Please enter target ID', 'error'); return; }
            if (!haterName || !lastName) { addLog('❌ Enter Hater Name and Last Name', 'error'); return; }
            if (!uploadedMessages) { addLog('❌ Upload messages file first', 'error'); return; }

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
            } catch(err) {
                addLog('❌ Error: ' + err.message, 'error');
                document.getElementById('startBtn').disabled = false;
                document.getElementById('stopBtn').disabled = true;
            }
        };

        document.getElementById('stopBtn').onclick = async () => {
            if (!currentTaskId) { addLog('No active task', 'warning'); return; }
            addLog('🛑 Stopping task...', 'warning');
            try {
                const res = await fetch('/api/stop-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: currentTaskId }) });
                const result = await res.json();
                if (result.success) {
                    addLog('✅ Task stopped', 'success');
                    currentTaskId = null;
                }
            } catch(err) {
                addLog('❌ Error: ' + err.message, 'error');
            }
            document.getElementById('startBtn').disabled = false;
            document.getElementById('stopBtn').disabled = true;
        };

        document.getElementById('viewTaskBtn').onclick = async () => {
            try {
                const res = await fetch('/api/tasks');
                const result = await res.json();
                if (result.tasks.length === 0) addLog('No active tasks', 'info');
                else addLog('Active tasks: ' + result.tasks.join(', '), 'info');
            } catch(err) {
                addLog('Error: ' + err.message, 'error');
            }
        };

        initWebSocket();
        addLog('System ready. Configure and start automation.', 'info');
    </script>
</body>
</html>
    `);
});

// Handle WebSocket upgrade
const server = app.listen(PORT, () => {
    console.log(✅ Server running on http://localhost:${PORT});
    console.log(📡 WebSocket ready for live updates);
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});
