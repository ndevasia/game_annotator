const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js');
const obs = new OBSWebSocket.OBSWebSocket();
const isDebug = process.argv.includes('--debug');
const path = require('path');
const AWSManager = require('./backend/aws.js');
const SessionMetadata = require('./backend/metadata.js')
const awsManager = new AWSManager();
const sessionMetadata = new SessionMetadata();

const configPath = `backend/config.json`;

if (fs.existsSync(configPath)) {
  userConfig = JSON.parse(fs.readFileSync(configPath));
}

let noteWindow = null;
let mainWindow = null;
let startWindow = null;
let usernamePromptWindow = null;

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
      sessionMetadata.setUsername(username);

      // Save to config.json
      const configToWrite = { username };
      fs.writeFileSync(configPath, JSON.stringify(configToWrite, null, 2));
      console.log('Saved username:', username);

      awsManager.createFileStructure(username)

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
      sessionMetadata.setVideoStartTimestamp(Date.now());
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

let isQuitting = false;

app.whenReady().then(async () => {
  console.log("A: App starting");
  if (!sessionMetadata.getUsername()) {
    console.log("Username required to proceed");
   await createUsernamePrompt();
  } 
  console.log("Username is ", sessionMetadata.getUsername())
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
      awsManager.saveAnnotationToS3(sessionMetadata.getUsername(), annotation, sessionMetadata.getFileTimestamp())
    } catch (err) {
      console.error('Error saving annotation:', err);
    }
  });
  ipcMain.on('save-start', (event, { title }) => {
    sessionMetadata.setTitle(title)
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
    if (sessionMetadata.getTitle() && sessionMetadata.getVideoStartTimestamp()) {
      awsManager.saveMetadata(sessionMetadata)
    }
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
