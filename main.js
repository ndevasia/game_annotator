const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js');
const { spawnTracked, killAllChildren } = require("./backend/processManager.js");
const obs = new OBSWebSocket.OBSWebSocket();
const isDebug = process.argv.includes('--debug');
const path = require('path');
const AWSManager = require('./backend/aws.js');
const SessionMetadata = require('./backend/metadata.js')
const sessionMetadata = new SessionMetadata();
const { readUsername, writeUsername, submitUsername } = require('./username.js');
const os = require('./os.js')

let awsManager = null;

// Instead of this, write it as an env variable and not a weird one off file
var writeToAWS = true;

const emojiReactions = {
  'CommandOrControl+1': '👍',  // Like
  'CommandOrControl+2': '❤️',  // Love
  'CommandOrControl+3': '😂',  // Haha
  'CommandOrControl+4': '😮',  // Wow
  'CommandOrControl+5': '😢',  // Sad
  'CommandOrControl+6': '😠',  // Angry
};

if (app.isPackaged) {
  console.log("Running packaged version of the app");
}

let noteWindow = null;
let mainWindow = null;
let startWindow = null;
let homeWindow = null;
let usernamePromptWindow = null;
let emojiWindow = null;
let loadingWindow = null;

let obsListenerAttached = false;
let isOBSConnected = false;
let shortcutsRegistered = false;
let isQuitting = false;

function createLoadingWindow() {
  if (loadingWindow) return;

  loadingWindow = new BrowserWindow({
    width: 300,
    height: 150,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  loadingWindow.loadFile('loading.html');

  loadingWindow.once('ready-to-show', () => {
    loadingWindow.show();
  });

  loadingWindow.on('closed', () => {
    loadingWindow = null;
  });
}

function closeLoadingWindow() {
  if (loadingWindow) {
    loadingWindow.close();
    loadingWindow = null;
  }
}

function createUsernamePrompt() {
  return new Promise(async (resolve) => {
    const username = await readUsername();
    if (username) {
      sessionMetadata.setUsername(username);
      return resolve();
    }

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
  });
}

function createEmojiWindow() {
  if (emojiWindow) return;

  emojiWindow = new BrowserWindow({
    width: 400,
    height: 200,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,          // click-through
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  emojiWindow.loadFile('emoji.html');

  emojiWindow.once('ready-to-show', () => {
    console.log('Emoji overlay ready');
  });

  emojiWindow.setIgnoreMouseEvents(true, { forward: true });

  emojiWindow.on('closed', () => {
    emojiWindow = null;
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
    focusable: true,
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

  noteWindow.setIgnoreMouseEvents(true, { forward: true });

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
    focusable: true,
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

function createHomeWindow() {
  return new Promise((resolve) => {
    // If already open, just focus it and return a fresh promise tied to user action
    if (homeWindow) {
      homeWindow.focus();
      return; // do not resolve yet, we still need user input
    }

    homeWindow = new BrowserWindow({
      width: 400,
      height: 300,
      alwaysOnTop: true,
      transparent: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      focusable: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    homeWindow.loadFile('home.html');

    homeWindow.once('ready-to-show', () => {
      homeWindow.show();
      console.log('Home window ready');
    });

    // Handlers for user actions
    const handleStart = () => {
      console.log("User chose: start new session");
      cleanup();
      resolve("start");
    };
    const handlePast = () => {
      console.log("User chose: view past sessions");
      cleanup();
      resolve("past");
    };

    // Cleanup function to remove listeners + close window
    function cleanup() {
      ipcMain.removeListener('open-start-session', handleStart);
      ipcMain.removeListener('open-past-sessions', handlePast);
      if (homeWindow) {
        homeWindow.close();
        homeWindow = null;
      }
    }

    // Always attach fresh listeners
    ipcMain.on('open-start-session', handleStart);
    ipcMain.on('open-past-sessions', handlePast);

    // Ensure window closure also cleans up listeners
    homeWindow.on('closed', () => cleanup());
  });
}


// Attach this ONCE during your app initialization
function attachOBSRecordingListener() {
  if (obsListenerAttached) return;
  obs.on('RecordStateChanged', async (data) => {
    console.log('🎥 OBS RecordStateChanged event:', data);
  });
  obsListenerAttached = true;
  console.log('📡 OBS recording listener attached');
}


async function connectOBS() {
  if (isOBSConnected) {
    console.log('OBS already connected');
    return;
  }
  try {
    await obs.connect();
    isOBSConnected = true;
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


async function stopOBSRecording(timeoutMs = 600000) {
  return new Promise(async (resolve, reject) => {
    let timeoutId;
    let sizeInterval;

    try {
      const { outputActive } = await obs.call('GetRecordStatus');
      if (!outputActive) {
        console.log('⚠ No active recording to stop.');
        return resolve();
      }

      console.log('🛑 Sending StopRecord and waiting for STOPPED event...');

      const onStopped = async (data) => {
        console.log(`📡 OBS RecordStateChanged: ${data.outputState}`);

        // Start monitoring file size when stopping begins
        if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING') {
          clearInterval(sizeInterval);
          sizeInterval = setInterval(() => {
            try {
              const stats = fs.statSync(data.outputPath);
              console.log(`💾 Writing file... ${Math.round(stats.size / (1024 * 1024))} MB`);
            } catch (e) {
              // file may not exist yet
            }
          }, 2000); // log every 2s
        }
        
        if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
          clearTimeout(timeoutId);
          clearInterval(sizeInterval);
          obs.off('RecordStateChanged', onStopped); // cleanup

          if (!data.outputPath) {
            console.warn('⚠ Recording stopped but no file path was returned.');
            return resolve();
          }

          try {
            // 1️⃣ Upload to S3
            console.log(`⬆️  Uploading video: ${data.outputPath}`);
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
        clearInterval(sizeInterval);
        console.error(`⏳ Timed out waiting for STOPPED event after ${timeoutMs}ms.`);
        resolve(); // still resolve so app can exit
      }, timeoutMs);

      obs.on('RecordStateChanged', onStopped);
      await obs.call('StopRecord');

    } catch (error) {
      clearTimeout(timeoutId);
      clearInterval(sizeInterval);
      reject(error);
    }
  });
}

function registerShortcuts() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;

  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (noteWindow && !noteWindow.isVisible()) {
      noteWindow.setFocusable(true);
      noteWindow.setIgnoreMouseEvents(false);
      noteWindow.show();
      noteWindow.focus();
    }
    if (noteWindow) {
      noteWindow.webContents.send('show-annotation-ui');
    }
  });

  for (const [shortcut, emoji] of Object.entries(emojiReactions)) {
    globalShortcut.register(shortcut, () => {
      if (emojiWindow) {
        emojiWindow.webContents.send('show-emoji', emoji);
      }
      // if awsManager exists, save (guard)
      if (awsManager) {
        awsManager.saveAnnotationToS3(sessionMetadata, { note: emoji, timestamp: Date.now() });
      }
    });
  }

  globalShortcut.register('CommandOrControl+Shift+Q', async () => {
    console.log('Quit hotkey pressed: stopping recording');
    if (isQuitting) return;
    isQuitting = true;
    try {
      createLoadingWindow();
      await stopOBSRecording();
      await disconnectOBSIfNeeded();
    } catch (err) {
      console.error('Error during OBS shutdown:', err);
    } finally {
      closeLoadingWindow();
    }
    if (noteWindow) {
      noteWindow.close();
    }
    createMainWindow();
  });
}

// --- when disconnecting, reset the flag ---
async function disconnectOBSIfNeeded() {
  try {
    if (isOBSConnected) {
      await obs.disconnect();
      isOBSConnected = false;
    }
  } catch (err) {
    console.warn('Error disconnecting OBS:', err);
  }
}

async function startSession() {
  console.log('➡ User starting session flow');
  attachOBSRecordingListener();
  registerShortcuts();
  createStartWindow();
  await connectOBS();        // wait until connected and recording started
  createNoteWindow();        // open overlay window
  createEmojiWindow();
}

async function handleHomeChoice(choice) {
  if (choice === 'start') {
    // If mainWindow is open (user came from past sessions), close it:
    if (mainWindow) {
      try { mainWindow.close(); } catch (e) {}
      mainWindow = null;
    }
    await startSession();
  } else if (choice === 'past') {
    // Make sure we don't leave duplicate mainWindows
    if (!mainWindow) createMainWindow();
    else mainWindow.show();
  }
}

app.whenReady().then(async () => {
  console.log("A: App starting");
  if (!sessionMetadata.getUsername()) {
    await createUsernamePrompt();
  }
  awsManager = new AWSManager(sessionMetadata.getUsername());
  await awsManager.init();

  // Blocking prompt at startup:
  const choice = await createHomeWindow();
  await handleHomeChoice(choice);
  });

  ipcMain.on('save-annotation', (event, annotation) => {
    try {
      if (writeToAWS) {
        awsManager.saveAnnotationToS3(sessionMetadata, annotation);
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
      noteWindow.setIgnoreMouseEvents(true, { forward: true });
      noteWindow.hide();
      noteWindow.setFocusable(false);
    }
  });
  ipcMain.on('hide-start', () => {
    if (startWindow && startWindow.isVisible()) {
      console.log("Closing start window");
      startWindow.close();
      startWindow = null;
    }
  });
  ipcMain.on('open-past-sessions', () => {
    createMainWindow();
  });
  ipcMain.on('open-home', async () => {
  if (mainWindow && mainWindow.isVisible()) {
    mainWindow.close();
    mainWindow = null;
  }
  const choice = await createHomeWindow();
  await handleHomeChoice(choice);
});
  ipcMain.on('hide-username', () => {
    if (usernamePromptWindow && usernamePromptWindow.isVisible()) {
      usernamePromptWindow.close();
    }
  });
  ipcMain.handle('get-video-start', () => {
    return videoStartTimestamp;
    });
  ipcMain.on('close-app', () => {
    console.log("Closing home");
    homeWindow.close();
    homeWindow = null;
    app.quit();
  });
  function maybeWriteSessionMetadata() {
    if (sessionMetadata.getTitle() && sessionMetadata.getVideoStartTimestamp()) {
      awsManager.saveMetadata(sessionMetadata)
    }
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (!isQuitting) {
      // Don't quit automatically — only quit when hotkey/explicit quit sets isQuitting
      return;
    }

    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
