const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js');
const obs = new OBSWebSocket.OBSWebSocket();
const isDebug = process.argv.includes('--debug');
const path = require('path');
require('dotenv').config();
const AWSManager = require('./backend/aws.js');
const awsManager = new AWSManager();

function getFormattedTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const MM = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${yyyy}-${MM}-${dd} ${hh}-${mm}-${ss}`;
}

const timestamp = getFormattedTimestamp();
const configPath = `config.json`;

let userConfig = {
  username: ''
};
if (fs.existsSync(configPath)) {
  userConfig = JSON.parse(fs.readFileSync(configPath));
}

// if (!fs.existsSync(annotationsFilePath)) {
//   fs.writeFileSync(annotationsFilePath, JSON.stringify([]));
// }

// if (!fs.existsSync(sessionsFilePath)) {
//   fs.writeFileSync(sessionsFilePath, JSON.stringify([]));
// }

let noteWindow = null;
let mainWindow = null;
let startWindow = null;
let usernamePromptWindow = null;
let videoStartTimestamp = null;
let sessionMetadata = {
  title: null,
  videoStartTimestamp: null,
};

function createUsernamePrompt() {
  return new Promise((resolve) => {
    const promptWindow = new BrowserWindow({
      width: 400,
      height: 200,
      modal: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      }
    });

    promptWindow.loadFile('username.html');

    promptWindow.once('ready-to-show', () => {
      promptWindow.show();
    });

    ipcMain.once('username-submitted', async (event, username) => {
      userConfig.username = username;

      // Save to config.json
      const configToWrite = { username };
      fs.writeFileSync(configPath, JSON.stringify(configToWrite, null, 2));
      console.log('Saved username:', username);

      awsManager.setUsername(username)

      promptWindow.close();
      resolve();
    });

  });
}



function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools();
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

function createNoteWindow() {
  if (noteWindow) return;

  noteWindow = new BrowserWindow({
    width: 400,
    height: 200,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  noteWindow.loadFile('overlay.html');

  noteWindow.once('ready-to-show', () => {
    console.log('Overlay window ready');
  });

  noteWindow.on('blur', () => noteWindow.hide());

  noteWindow.on('closed', async () => {
    noteWindow = null;
  });
}

function createStartWindow() {
  if (startWindow) return;

  startWindow = new BrowserWindow({
    width: 400,
    height: 200,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  startWindow.loadFile('start.html');

  startWindow.once('ready-to-show', () => {
    console.log('Start window ready');
  });

}

async function connectOBS() {
  try {
    await obs.connect();
    console.log('Connected to OBS WebSocket');
    const { outputActive } = await obs.call('GetRecordStatus');
    if (!outputActive) {
      await obs.call('StartRecord');
      sessionMetadata.videoStartTimestamp = Date.now();
      maybeWriteSessionMetadata();
      console.log('OBS recording started');
    }
  } catch (error) {
    console.error('Failed to connect/start OBS recording:', error);
  }
}

async function stopOBSRecording() {
  try {
    const { outputActive } = await obs.call('GetRecordStatus');
    if (outputActive) {
      await obs.call('StopRecord')
      console.log('OBS recording stopped');
    }
  } catch (error) {
    console.error('Failed to stop recording:', error);
  }
}

async function uploadToS3UsingPresignedUrl(filePath) {
  const fileName = path.basename(filePath);

  // Step 1: Ask the server for a presigned URL
  const response = await fetch('http://localhost:5000/generate-presigned-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
  });

  const { url, s3_key } = await response.json();

  // Step 2: Upload file using PUT to S3
  const fileBuffer = fs.readFileSync(filePath);
  await fetch(url, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': 'video/mkv', // or whatever your file type is
    },
  });

  console.log('Upload complete:', s3_key);
}


let isQuitting = false;

app.whenReady().then(async () => {
  console.log("A: App starting");
  if (!userConfig.username) {
    console.log("Username required to proceed");
   await createUsernamePrompt();
  } 
  console.log("Username is ", userConfig.username)
  if (isDebug) {
    console.log('DEBUG MODE: launching main window only');
    createMainWindow();
    return;
  }
  createStartWindow();
  await connectOBS();        // Wait for OBS to be ready and start recording
  createNoteWindow();        // Then open the overlay window

  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (noteWindow && !noteWindow.isVisible()) {
      noteWindow.show();
      noteWindow.focus();
    }
  });

  globalShortcut.register('CommandOrControl+Shift+Q', async () => {
    console.log('Quit hotkey pressed: stopping recording');
    app.quit();
  });

  ipcMain.on('save-annotation', (event, annotation) => {
    try {
      awsManager.saveAnnotationToS3(userConfig.username, annotation, timestamp)
    } catch (err) {
      console.error('Error saving annotation:', err);
    }
  });
  ipcMain.on('save-start', (event, { title }) => {
    sessionMetadata.title = title;
    maybeWriteSessionMetadata();
  });


  ipcMain.on('hide-overlay', () => {
    if (noteWindow && noteWindow.isVisible()) {
      noteWindow.hide();
    }
  });
  ipcMain.on('hide-start', () => {
    if (startWindow && startWindow.isVisible()) {
      startWindow.hide();
    }
  });
  ipcMain.on('hide-username', () => {
    if (usernamePromptWindow && usernamePromptWindow.isVisible()) {
      usernamePromptWindow.hide();
    }
  });
  ipcMain.handle('get-video-start', () => {
    return videoStartTimestamp;
    });
  });
  function maybeWriteSessionMetadata() {
    if (sessionMetadata.title && sessionMetadata.videoStartTimestamp) {
      awsManager.saveMetadata(userConfig.username, sessionMetadata.title, timestamap, sessionMetadata.videoStartTimestamp)
    }
  }
  function maybeWriteUserData() {
    const configToWrite = { username: userConfig.username };
    fs.writeFileSync(configPath, JSON.stringify(configToWrite, null, 1));
    console.log('Username set:', userConfig.username);
  }

app.on('before-quit', async (event) => {
  if (!isQuitting  && !isDebug) {
    event.preventDefault(); // prevent immediate quit
    console.log('Gracefully stopping OBS before quitting...');
    
    isQuitting = true;

    try {
      await stopOBSRecording();
      await obs.disconnect(); // separate OBS disconnect if needed
    } catch (err) {
      console.error('Error during OBS shutdown:', err);
    }

    // Close overlay window
    if (noteWindow) {
      noteWindow.close();
    }

    // ⬇️ Call your S3 bucket logic for video recording here
    // await uploadToS3UsingPresignedUrl(annotationsFilePath);
    // Now launch main window (for playback)
     createMainWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
