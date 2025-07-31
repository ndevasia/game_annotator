const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js');
const obs = new OBSWebSocket.OBSWebSocket();

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
const annotationsFilePath = `annotations/${timestamp}.json`;

if (!fs.existsSync(annotationsFilePath)) {
  fs.writeFileSync(annotationsFilePath, JSON.stringify([]));
}

let noteWindow = null;
let mainWindow = null;
let videoStartTimestamp = null;

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
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Sending videoStartTimestamp:', videoStartTimestamp);
    mainWindow.webContents.send('video-start-timestamp', videoStartTimestamp);
  });
  mainWindow.webContents.openDevTools();
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

async function connectOBS() {
  try {
    await obs.connect();
    console.log('Connected to OBS WebSocket');
    const { outputActive } = await obs.call('GetRecordStatus');
    if (!outputActive) {
      await obs.call('StartRecord');
      videoStartTimestamp = Date.now();
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
      await obs.call('StopRecord');
      console.log('OBS recording stopped');
    }
  } catch (error) {
    console.error('Failed to stop recording:', error);
  }
}

let isQuitting = false;

app.whenReady().then(async () => {
  await connectOBS();        // Wait for OBS to be ready and start recording
  createNoteWindow();        // Then open the overlay window

  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (noteWindow && !noteWindow.isVisible()) {
      noteWindow.show();
      noteWindow.focus();
    }
  });

  globalShortcut.register('CommandOrControl+Shift+Q', async () => {
    console.log('Quit hotkey pressed: stopping recording and quitting app');
    // await stopOBSRecording();
    // obs.disconnect();
    app.quit();
  });

  ipcMain.on('save-annotation', (event, annotation) => {
    try {
      const data = fs.readFileSync(annotationsFilePath);
      const annotations = JSON.parse(data);
      annotations.push(annotation);
      fs.writeFileSync(annotationsFilePath, JSON.stringify(annotations, null, 2));
    } catch (err) {
      console.error('Error saving annotation:', err);
    }
  });

  ipcMain.on('hide-overlay', () => {
    if (noteWindow && noteWindow.isVisible()) {
      noteWindow.hide();
    }
  });
  ipcMain.handle('get-video-start', () => {
    return videoStartTimestamp;
    });
});

app.on('before-quit', async (event) => {
  if (!isQuitting) {
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
