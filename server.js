const express = require('express');
const multer = require('multer');
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Facebook API call with cookies only
async function facebookApiRequest(url, method = 'GET', data = null, cookies = null) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Cache-Control': 'max-age=0',
            'TE': 'Trailers'
        };

        if (cookies) {
            headers['Cookie'] = cookies;
        }

        const response = await axios({
            method: method,
            url: url,
            headers: headers,
            data: data,
            timeout: 30000,
            withCredentials: true
        });

        return { success: true, data: response.data };
    } catch (error) {
        return { 
            success: false, 
            error: error.response?.data?.error?.message || error.message 
        };
    }
}

// Validate cookies by fetching user profile
async function validateCookies(cookies) {
    try {
        // Try to get user info using graph API
        const url = 'https://graph.facebook.com/me?fields=id,name,email';
        const result = await facebookApiRequest(url, 'GET', null, cookies);
        
        if (result.success && result.data && result.data.id) {
            broadcastLog(`✅ Logged in as: ${result.data.name || result.data.id}`, 'success');
            return true;
        }
        
        // Alternative: Try to access facebook.com home page
        const homeUrl = 'https://www.facebook.com/';
        const homeResult = await facebookApiRequest(homeUrl, 'GET', null, cookies);
        
        if (homeResult.success && homeResult.data && homeResult.data.includes('logged_in')) {
            broadcastLog(`✅ Facebook session is active`, 'success');
            return true;
        }
        
        return false;
    } catch (error) {
        broadcastLog(`❌ Cookie validation error: ${error.message}`, 'error');
        return false;
    }
}

// Post comment using Facebook Graph API with cookies
async function postComment(postId, message, cookies) {
    try {
        const url = `https://graph.facebook.com/v18.0/${postId}/comments`;
        const data = { message: message };
        
        const result = await facebookApiRequest(url, 'POST', data, cookies);
        
        if (result.success && result.data && result.data.id) {
            return { success: true, id: result.data.id };
        } else {
            // Try different API version
            const url2 = `https://graph.facebook.com/v15.0/${postId}/comments`;
            const result2 = await facebookApiRequest(url2, 'POST', data, cookies);
            
            if (result2.success && result2.data && result2.data.id) {
                return { success: true, id: result2.data.id };
            }
            
            return { success: false, error: result.error || 'Failed to post comment' };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Post reply using Facebook Graph API with cookies
async function postReply(commentId, message, cookies) {
    try {
        const url = `https://graph.facebook.com/v18.0/${commentId}/comments`;
        const data = { message: message };
        
        const result = await facebookApiRequest(url, 'POST', data, cookies);
        
        if (result.success && result.data && result.data.id) {
            return { success: true, id: result.data.id };
        } else {
            const url2 = `https://graph.facebook.com/v15.0/${commentId}/comments`;
            const result2 = await facebookApiRequest(url2, 'POST', data, cookies);
            
            if (result2.success && result2.data && result2.data.id) {
                return { success: true, id: result2.data.id };
            }
            
            return { success: false, error: result.error || 'Failed to post reply' };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function executeTask(taskId, taskConfig, messages) {
    const { toolType, targetId, cookies, delay, haterName, lastName } = taskConfig;
    
    broadcastLog(`🚀 Task started: ${toolType === 'comment' ? 'Comment Tool' : 'Reply Tool'}`, 'success');
    broadcastLog(`🎯 Target ID: ${targetId}`, 'info');
    broadcastLog(`⏱️ Delay: ${delay} seconds between messages`, 'info');
    broadcastLog(`📝 Total messages to send: ${messages.length}`, 'info');
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < messages.length; i++) {
        if (!activeTasks.has(taskId)) {
            broadcastLog(`🛑 Task stopped by user`, 'warning');
            break;
        }
        
        const prefixedMessage = `${haterName} ${lastName}: ${messages[i]}`;
        broadcastLog(`📤 [${i + 1}/${messages.length}] Sending: "${prefixedMessage.substring(0, 60)}${prefixedMessage.length > 60 ? '...' : ''}"`, 'info');
        
        let result;
        if (toolType === 'comment') {
            result = await postComment(targetId, prefixedMessage, cookies);
        } else {
            result = await postReply(targetId, prefixedMessage, cookies);
        }
        
        if (result.success) {
            successCount++;
            broadcastLog(`✅ [${i + 1}/${messages.length}] Message sent successfully!`, 'success');
        } else {
            failCount++;
            broadcastLog(`❌ [${i + 1}/${messages.length}] Failed: ${result.error}`, 'error');
        }
        
        if (i < messages.length - 1 && activeTasks.has(taskId)) {
            broadcastLog(`⏳ Waiting ${delay} seconds before next message...`, 'info');
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }
    
    broadcastLog(`📊 Task completed! ✅ Success: ${successCount} | ❌ Failed: ${failCount}`, successCount > 0 ? 'success' : 'error');
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
        
        broadcastLog('🔍 Validating Facebook cookies...', 'info');
        broadcastLog('💡 Checking if cookies are valid and session is active...', 'info');
        
        const isValid = await validateCookies(cookies);
        
        if (!isValid) {
            broadcastLog('❌ Invalid cookies! Please check your Facebook cookies.', 'error');
            broadcastLog('📌 How to get valid cookies:', 'info');
            broadcastLog('   1. Open Facebook.com and login', 'info');
            broadcastLog('   2. Press F12 → Application tab', 'info');
            broadcastLog('   3. Cookies → https://www.facebook.com', 'info');
            broadcastLog('   4. Copy all cookies in format: name=value; name=value', 'info');
            return res.status(401).json({ error: 'Invalid cookies. Please check your Facebook login session.' });
        }
        
        broadcastLog('✅ Cookies validated successfully! Session is active.', 'success');
        
        const taskId = uuidv4();
        const taskConfig = { toolType, targetId, cookies, delay: parseInt(delay), haterName, lastName };
        
        activeTasks.set(taskId, { config: taskConfig, messages: messages });
        executeTask(taskId, taskConfig, messages).catch(error => {
            broadcastLog(`❌ Task error: ${error.message}`, 'error');
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
            broadcastLog(`🛑 Task stopped by user request`, 'warning');
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
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', sans-serif;
            background: radial-gradient(circle at 0% 0%, #1a0b2e 0%, #0f0c29 50%, #1a1a2e 100%);
            min-height: 100vh;
            padding: 30px 20px;
        }
        .container { max-width: 750px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; animation: fadeInDown 0.6s ease-out; }
        @keyframes fadeInDown {
            from { opacity: 0; transform: translateY(-30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .header h1 {
            background: linear-gradient(135deg, #fff 0%, #c4b5fd 50%, #a78bfa 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-size: 32px;
            font-weight: 800;
            margin-bottom: 10px;
        }
        .header-links a { color: #a78bfa; text-decoration: none; font-size: 13px; background: rgba(139,92,246,0.1); padding: 5px 10px; border-radius: 8px; }
        .card {
            background: rgba(20, 17, 45, 0.8);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 30px;
            border: 1px solid rgba(139,92,246,0.2);
            animation: fadeInUp 0.6s ease-out;
        }
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .tool-toggle { display: flex; gap: 15px; margin-bottom: 30px; }
        .tool-btn {
            flex: 1; padding: 14px; background: rgba(30,27,58,0.6);
            border: 1px solid rgba(139,92,246,0.3); color: #a0aec0;
            border-radius: 16px; font-size: 16px; font-weight: 600;
            cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px;
            transition: all 0.3s ease;
        }
        .tool-btn:hover { transform: translateY(-2px); background: rgba(45,41,78,0.8); }
        .tool-btn.active {
            background: linear-gradient(135deg, #8b5cf6, #6d28d9);
            color: white; box-shadow: 0 10px 20px -5px rgba(139,92,246,0.4);
        }
        .form-content { display: flex; flex-direction: column; gap: 22px; }
        .input-field { display: flex; flex-direction: column; gap: 8px; }
        .input-field label { color: #c4b5fd; font-size: 14px; font-weight: 600; }
        .input-field textarea, .input-field input {
            background: rgba(10,8,25,0.8);
            border: 1px solid rgba(139,92,246,0.3);
            border-radius: 14px; padding: 12px 16px; color: #fff; font-size: 14px;
            transition: all 0.3s ease;
        }
        .input-field textarea:focus, .input-field input:focus {
            outline: none; border-color: #8b5cf6; box-shadow: 0 0 0 3px rgba(139,92,246,0.1);
        }
        .input-field textarea { min-height: 100px; resize: vertical; font-family: monospace; }
        .row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        .file-input-wrapper {
            display: flex; align-items: center; gap: 12px;
            background: rgba(10,8,25,0.8);
            border: 1px solid rgba(139,92,246,0.3);
            border-radius: 14px; padding: 8px 12px;
        }
        .file-btn {
            background: linear-gradient(135deg, #6b46c1, #553c9a);
            color: white; border: none; padding: 8px 24px; border-radius: 10px; cursor: pointer;
            transition: all 0.3s ease;
        }
        .file-btn:hover { transform: translateY(-1px); background: linear-gradient(135deg, #7c5ac9, #6b46c1); }
        .file-name { color: #9ca3af; font-size: 13px; flex: 1; }
        .action-buttons { display: flex; gap: 15px; margin: 25px 0; }
        .action-btn {
            flex: 1; padding: 14px; border: none; border-radius: 14px;
            font-size: 15px; font-weight: 700; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            transition: all 0.3s ease;
        }
        .action-btn:hover:not(:disabled) { transform: translateY(-2px); }
        .start-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; box-shadow: 0 4px 15px rgba(16,185,129,0.3); }
        .stop-btn { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; box-shadow: 0 4px 15px rgba(239,68,68,0.3); }
        .view-btn { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; box-shadow: 0 4px 15px rgba(59,130,246,0.3); }
        .action-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .console-section {
            background: rgba(0,0,0,0.5);
            backdrop-filter: blur(10px);
            border-radius: 20px; padding: 20px;
            border: 1px solid rgba(139,92,246,0.2);
        }
        .console-title { display: flex; justify-content: space-between; margin-bottom: 15px; color: #c4b5fd; font-weight: 600; }
        .clear-console { background: rgba(139,92,246,0.2); border: none; color: #c4b5fd; padding: 5px 18px; border-radius: 10px; cursor: pointer; transition: all 0.3s ease; }
        .clear-console:hover { background: rgba(139,92,246,0.4); color: white; }
        .console-output {
            background: rgba(0,0,0,0.6);
            border-radius: 14px; padding: 15px; height: 300px;
            overflow-y: auto; font-family: 'Courier New', monospace; font-size: 12px;
        }
        .log-line { padding: 6px 0; border-bottom: 1px solid rgba(139,92,246,0.1); animation: slideIn 0.2s ease-out; }
        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-10px); }
            to { opacity: 1; transform: translateX(0); }
        }
        .log-line .time { color: #6b7280; margin-right: 12px; }
        .log-line.info { color: #60a5fa; }
        .log-line.success { color: #34d399; }
        .log-line.error { color: #f87171; }
        .log-line.warning { color: #fbbf24; }
        .console-output::-webkit-scrollbar { width: 6px; }
        .console-output::-webkit-scrollbar-track { background: rgba(0,0,0,0.4); border-radius: 10px; }
        .console-output::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.5); border-radius: 10px; }
        @media (max-width: 600px) {
            .tool-toggle, .row, .action-buttons { flex-direction: column; }
            .row { grid-template-columns: 1fr; }
            .header h1 { font-size: 24px; }
            .card { padding: 20px; }
        }
        small { color: #a78bfa; font-size: 11px; margin-top: 5px; display: block; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 FB AUTOMATOR | AYAZ DON</h1>
            <div class="header-links"><a href="#">http://fi11.bot-hosting.net:21132</a></div>
        </div>
        <div class="card">
            <div class="tool-toggle">
                <button class="tool-btn active" id="commentToolBtn">💬 Comment Tool</button>
                <button class="tool-btn" id="replyToolBtn">↩️ Reply Tool</button>
            </div>
            <div class="form-content">
                <div class="input-field">
                    <label>📋 Facebook Cookies</label>
                    <textarea id="cookies" placeholder="c_user=123456789; xs=1234567890; datr=...; fr=..."></textarea>
                    <small>💡 How to get: Login Facebook → F12 → Application → Cookies → Copy all as "name=value; name=value"</small>
                </div>
                <div class="input-field">
                    <label id="targetLabel">📌 Facebook Post UID</label>
                    <input type="text" id="targetId" placeholder="Enter Post UID (e.g., 123456789012345)">
                </div>
                <div class="row">
                    <div class="input-field"><label>👤 Hater Name</label><input type="text" id="haterName" placeholder="First Name"></div>
                    <div class="input-field"><label>📝 Last Name</label><input type="text" id="lastName" placeholder="Last Name"></div>
                </div>
                <div class="input-field">
                    <label>📁 Upload .txt messages</label>
                    <div class="file-input-wrapper">
                        <input type="file" id="messagesFile" accept=".txt" style="display:none">
                        <button class="file-btn" id="fileSelectBtn">Choose File</button>
                        <span id="fileName" class="file-name">No file chosen</span>
                    </div>
                    <small>📝 Each line in file = one message</small>
                </div>
                <div class="input-field">
                    <label>⏱️ Delay (seconds)</label>
                    <input type="number" id="delay" value="20" min="5" max="999">
                </div>
            </div>
        </div>
        <div class="action-buttons">
            <button class="action-btn start-btn" id="startBtn">▶ Start</button>
            <button class="action-btn stop-btn" id="stopBtn" disabled>⏹️ Stop</button>
            <button class="action-btn view-btn" id="viewTaskBtn">📋 View Task</button>
        </div>
        <div class="console-section">
            <div class="console-title"><span>📺 Live Console</span><button class="clear-console" id="clearConsoleBtn">Clear</button></div>
            <div class="console-output" id="liveConsole">
                <div class="log-line info"><span class="time">[System]</span> 🚀 FB Automator is ready!</div>
                <div class="log-line info"><span class="time">[System]</span> 💡 Paste your Facebook cookies and start automation</div>
            </div>
        </div>
    </div>
    <script>
        let currentTaskId = null, uploadedMessages = null, currentTool = 'comment', ws = null;
        
        function initWebSocket() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + location.host);
            ws.onopen = () => addLog('🔌 WebSocket connected! Live updates enabled', 'success');
            ws.onmessage = (event) => { const log = JSON.parse(event.data); addLog(log.message, log.type); };
            ws.onclose = () => setTimeout(initWebSocket, 3000);
        }
        
        function addLog(msg, type='info') {
            const div = document.getElementById('liveConsole');
            const line = document.createElement('div');
            line.className = 'log-line ' + type;
            line.innerHTML = '<span class="time">[' + new Date().toLocaleTimeString() + ']</span> ' + msg;
            div.appendChild(line);
            line.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        
        document.getElementById('commentToolBtn').onclick = () => {
            document.getElementById('commentToolBtn').classList.add('active');
            document.getElementById('replyToolBtn').classList.remove('active');
            currentTool = 'comment';
            document.getElementById('targetLabel').innerHTML = '📌 Facebook Post UID';
            document.getElementById('targetId').placeholder = 'Enter Post UID';
            addLog('Switched to Comment Tool', 'info');
        };
        
        document.getElementById('replyToolBtn').onclick = () => {
            document.getElementById('replyToolBtn').classList.add('active');
            document.getElementById('commentToolBtn').classList.remove('active');
            currentTool = 'reply';
            document.getElementById('targetLabel').innerHTML = '💬 Facebook Comment UID';
            document.getElementById('targetId').placeholder = 'Enter Comment UID';
            addLog('Switched to Reply Tool', 'info');
        };
        
        document.getElementById('fileSelectBtn').onclick = () => document.getElementById('messagesFile').click();
        document.getElementById('messagesFile').onchange = async (e) => {
            const file = e.target.files[0];
            if(file) {
                document.getElementById('fileName').textContent = file.name;
                const fd = new FormData();
                fd.append('messagesFile', file);
                addLog('📤 Uploading ' + file.name + '...', 'info');
                try {
                    const res = await fetch('/api/upload-messages', { method: 'POST', body: fd });
                    const result = await res.json();
                    if(result.success) { uploadedMessages = result.messages; addLog('✅ Loaded ' + uploadedMessages.length + ' messages', 'success'); }
                    else addLog('❌ Upload failed', 'error');
                } catch(err) { addLog('❌ Error: ' + err.message, 'error'); }
            }
        };
        
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
            
            if(!cookies) { addLog('❌ Please paste Facebook cookies', 'error'); return; }
            if(!targetId) { addLog('❌ Please enter target ID', 'error'); return; }
            if(!haterName || !lastName) { addLog('❌ Please enter Hater Name and Last Name', 'error'); return; }
            if(!uploadedMessages) { addLog('❌ Please upload a .txt file with messages', 'error'); return; }
            
            addLog('🚀 Starting automation task...', 'info');
            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;
            
            try {
                const res = await fetch('/api/start-task', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toolType: currentTool, targetId, cookies, delay: parseInt(delay), haterName, lastName, messages: uploadedMessages })
                });
                const result = await res.json();
                if(result.success) { currentTaskId = result.taskId; addLog('✅ Task started! ID: ' + currentTaskId, 'success'); }
                else { addLog('❌ Failed: ' + result.error, 'error'); document.getElementById('startBtn').disabled = false; document.getElementById('stopBtn').disabled = true; }
            } catch(err) { addLog('❌ Error: ' + err.message, 'error'); document.getElementById('startBtn').disabled = false; document.getElementById('stopBtn').disabled = true; }
        };
        
        document.getElementById('stopBtn').onclick = async () => {
            if(!currentTaskId) { addLog('No active task to stop', 'warning'); return; }
            addLog('🛑 Stopping task...', 'warning');
            try {
                await fetch('/api/stop-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: currentTaskId }) });
                addLog('✅ Task stopped successfully', 'success');
            } catch(err) { addLog('❌ Error: ' + err.message, 'error'); }
            document.getElementById('startBtn').disabled = false;
            document.getElementById('stopBtn').disabled = true;
            currentTaskId = null;
        };
        
        document.getElementById('viewTaskBtn').onclick = async () => {
            try {
                const res = await fetch('/api/tasks');
                const result = await res.json();
                if(result.tasks.length === 0) addLog('No active tasks running', 'info');
                else addLog('Active tasks: ' + result.tasks.join(', '), 'info');
            } catch(err) { addLog('Error: ' + err.message, 'error'); }
        };
        
        initWebSocket();
        addLog('💡 Tip: Make sure you are logged into Facebook and cookies are fresh', 'info');
        addLog('⚡ Ready to automate!', 'success');
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
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready for live updates`);
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});
