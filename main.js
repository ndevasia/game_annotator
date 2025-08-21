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

// Instead of this, write it as an env variable and not a weird one off file
const configPath = `backend/config.json`;
var writeToAWS = true;

const emojiReactions = {
  'CommandOrControl+1': '👍',  // Like
  'CommandOrControl+2': '❤️',  // Love
  'CommandOrControl+3': '😂',  // Haha
  'CommandOrControl+4': '😮',  // Wow
  'CommandOrControl+5': '😢',  // Sad
  'CommandOrControl+6': '😠',  // Angry
};

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
  // mainWindow.webContents.openDevTools();
  mainWindow.webContents.on('did-finish-load', () => {
    // Send sessionMetadata object or whatever data you want
    console.log("Sending username to index.html ", sessionMetadata.getUsername());
    mainWindow.webContents.send('session-data', sessionMetadata.getUsername());
  });
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
    focusable: false,
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

  noteWindow.on('blur', () => {
    noteWindow.hide()
    noteWindow.setFocusable(false);
  });

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

// Attach this ONCE during your app initialization
function attachOBSRecordingListener() {
  obs.on('RecordStateChanged', async (data) => {
    console.log('🎥 OBS RecordStateChanged event:', data);

    // Only trigger on fully stopped recordings with a valid file path
    if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED' && data.outputPath) {
      const filePath = data.outputPath;
      console.log(`✅ Recording finalized at: ${filePath}`);

      try {
        const fileBuffer = fs.readFileSync(filePath);
        await awsManager.uploadFile(fileBuffer, sessionMetadata.getUsername(), sessionMetadata.getFileTimestamp(), 'videos');
        console.log('✅ Video uploaded to S3.');
      } catch (err) {
        console.error('❌ Failed to upload video:', err);
        writeToAWS = false;
      }
    }
  });

  console.log('📡 OBS recording listener attached');
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

async function stopOBSRecording(timeoutMs = 60000) {
  return new Promise(async (resolve, reject) => {
    let timeoutId;

    try {
      const { outputActive } = await obs.call('GetRecordStatus');
      if (!outputActive) {
        console.log('⚠ No active recording to stop.');
        return resolve();
      }

      console.log('🛑 Sending StopRecord and waiting for STOPPED event...');

      const onStopped = async (data) => {
        if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
          clearTimeout(timeoutId);
          obs.off('RecordStateChanged', onStopped); // cleanup

          if (!data.outputPath) {
            console.warn('⚠ Recording stopped but no file path was returned.');
            return resolve();
          }

          try {
            // 1️⃣ Upload to S3
            const fileBuffer = fs.readFileSync(data.outputPath);
            await awsManager.uploadFile(
              fileBuffer,
              sessionMetadata.getUsername(),
              sessionMetadata.getFileTimestamp(),
              'videos'
            );
            console.log('✅ Video uploaded to S3.');

            // 2️⃣ Delete local file
            await fs.promises.unlink(data.outputPath);
            console.log(`🗑 Deleted local file: ${data.outputPath}`);
          } catch (err) {
            console.error('❌ Failed during upload/delete process:', err);
          }

          resolve();
        }
      };

      // Fail-safe timeout
      timeoutId = setTimeout(() => {
        obs.off('RecordStateChanged', onStopped);
        console.error(`⏳ Timed out waiting for STOPPED event after ${timeoutMs}ms.`);
        resolve(); // still resolve so app can exit
      }, timeoutMs);

      obs.on('RecordStateChanged', onStopped);
      await obs.call('StopRecord');

    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
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
  attachOBSRecordingListener();
  createStartWindow();
  await connectOBS();        // Wait for OBS to be ready and start recording
  createNoteWindow();        // Then open the overlay window

  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (noteWindow && !noteWindow.isVisible()) {
      noteWindow.setFocusable(true)
      noteWindow.show();
      noteWindow.focus();
    }
    if (noteWindow) {
      noteWindow.webContents.send('show-annotation-ui');
    }
  });

  for (const [shortcut, emoji] of Object.entries(emojiReactions)) {
    globalShortcut.register(shortcut, () => {
      if (noteWindow) {
        if (!noteWindow.isVisible()) noteWindow.show();
        noteWindow.webContents.send('emoji-reaction', emoji);
        awsManager.saveAnnotationToS3(sessionMetadata.getUsername(), { note: emoji, timestamp: Date.now() }, sessionMetadata.getFileTimestamp())
      }
    });
  }

  globalShortcut.register('CommandOrControl+Shift+Q', async () => {
    console.log('Quit hotkey pressed: stopping recording');
    app.quit();
  });

  ipcMain.on('save-annotation', (event, annotation) => {
    try {
      if (writeToAWS) {
        awsManager.saveAnnotationToS3(sessionMetadata.getUsername(), annotation, sessionMetadata.getFileTimestamp());
      }
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
