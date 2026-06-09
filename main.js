const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen } = require('electron');
console.log('🚀 main.js starting to load (OBS version)...');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { spawnTracked, killAllChildren } = require("./backend/processManager.js");
const OBSWebSocket = require('obs-websocket-js');
const obs = new OBSWebSocket.OBSWebSocket();
const isDebug = process.argv.includes('--debug');
const path = require('path');
const AWSManager = require('./backend/aws.js');
const SessionMetadata = require('./backend/metadata.js');
const GeminiService = require('./backend/geminiService.js');
const { readConfig, writeConfig } = require('./config.js');
const sessionMetadata = new SessionMetadata();
const { readUsername, writeUsername, submitUsername } = require('./username.js');
const os = require('./os.js');
const StudyConditions = require('./backend/studyConditions.js');

let geminiService = null;
try {
  geminiService = new GeminiService();
} catch (err) {
  console.warn('⚠️ Gemini service not available:', err.message);
}

let awsManager = null;
let studyConditions = new StudyConditions();
let modeSelectWindow = null;
let conditionSelectWindow = null;
let selectedStudyCondition = null;
let studyLoginInfo = null;

var focusedWindow = null;

// Instead of this, write it as an env variable and not a weird one off file
var writeToAWS = true;

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
let settingsWindow = null;
let recentNotesWindow = null;
let reviewWindow = null;
let promptWindow = null;
let studyLoginWindow = null;
let questionnaireWindow = null;

let obsListenerAttached = false;
let isOBSConnected = false;
let shortcutsRegistered = false;
let isUploading = false;
let isReturningHome = false;
let userQuitFromHome = false;
let isNavigatingFromHome = false;
let isStarting = false;
let isRecordingSetup = false;

let appConfig = {
  recordAllDisplays: true,
  selectedDisplayId: null,
  localOnlyStorage: false,
  showRecentNotesOverlay: true,
  reviewMode: 'none', // 'none', 'ai', or 'text'
  recentNotesCount: 3,
  hotkeys: {
    annotationWindow: 'CommandOrControl+Shift+N',
    showPastSessions: 'CommandOrControl+Shift+O',
    quitRecording: 'CommandOrControl+Shift+Q',
    toggleRecentNotesOverlay: 'CommandOrControl+Shift+P',
    emoji1: 'CommandOrControl+Shift+1',
    emoji2: 'CommandOrControl+Shift+2',
    emoji3: 'CommandOrControl+Shift+3',
    emoji4: 'CommandOrControl+Shift+4',
    emoji5: 'CommandOrControl+Shift+5',
    emoji6: 'CommandOrControl+Shift+6',
  },
};

function getLocalSessionRoot() {
  return path.join(app.getPath('userData'), 'local_sessions');
}

function getLocalSessionPaths(username, fileTimestamp) {
  const userRoot = path.join(getLocalSessionRoot(), username);
  return {
    userRoot,
    videosDir: path.join(userRoot, 'videos'),
    metadataDir: path.join(userRoot, 'metadata'),
    annotationsDir: path.join(userRoot, 'annotations'),
    chatsDir: path.join(userRoot, 'chats'),
    videoPath: path.join(userRoot, 'videos', `${fileTimestamp}.mkv`),
    metadataPath: path.join(userRoot, 'metadata', `${fileTimestamp}.json`),
    annotationsPath: path.join(userRoot, 'annotations', `${fileTimestamp}.json`),
  };
}

async function ensureLocalSessionDirs(username) {
  const paths = getLocalSessionPaths(username, '');
  for (const dir of [paths.videosDir, paths.metadataDir, paths.annotationsDir, paths.chatsDir]) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

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
  mainWindow.webContents.on('did-finish-load', () => {
    console.log("Sending username to index.html ", sessionMetadata.getUsername());
    mainWindow.webContents.send('session-data', sessionMetadata.getUsername());
  });

  mainWindow.on('close', (e) => {
    if (isUploading || isReturningHome) return;

    e.preventDefault();

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Yes, Quit', 'No, Keep it open'],
      title: 'Confirm Quit',
      message: 'Are you sure you want to quit the app?',
      defaultId: 0,
      cancelId: 1
    });

    if (choice === 0) {
      app.quit(); 
    }
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
    focusable: false,
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

  noteWindow.on('closed', () => {
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

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 850,
    modal: true,
    parent: homeWindow || null,
    resizable: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  settingsWindow.loadFile('settings.html');

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createHomeWindow() {
  return new Promise((resolve) => {
    if (homeWindow) {
      homeWindow.focus();
      return;
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

    function cleanup() {
      ipcMain.removeListener('open-start-session', handleStart);
      ipcMain.removeListener('open-past-sessions', handlePast);
      if (homeWindow) {
        homeWindow.close();
        homeWindow = null;
      }
    }

    ipcMain.on('open-start-session', handleStart);
    ipcMain.on('open-past-sessions', handlePast);

    homeWindow.on('closed', () => cleanup());
  });
}

// Attach OBS recording listener
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

        if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING') {
          clearInterval(sizeInterval);
          sizeInterval = setInterval(() => {
            try {
              const stats = fs.statSync(data.outputPath);
              console.log(`💾 Writing file... ${Math.round(stats.size / (1024 * 1024))} MB`);
            } catch (e) {
              // file may not exist yet
            }
          }, 2000);
        }
        
        if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
          clearTimeout(timeoutId);
          clearInterval(sizeInterval);
          obs.off('RecordStateChanged', onStopped);

          if (!data.outputPath) {
            console.warn('⚠ Recording stopped but no file path was returned.');
            return resolve();
          }

          try {
            const username = sessionMetadata.getUsername();
            const fileTimestamp = sessionMetadata.getFileTimestamp();
            const localPaths = getLocalSessionPaths(username, fileTimestamp);

            // Save locally first
            await ensureLocalSessionDirs(username);
            await fs.promises.copyFile(data.outputPath, localPaths.videoPath);
            console.log(`✅ Video saved locally: ${localPaths.videoPath}`);

            // Upload to S3 if enabled
            if (shouldUploadToS3()) {
              try {
                const fileBuffer = fs.readFileSync(data.outputPath);
                await awsManager.uploadFile(
                  fileBuffer,
                  username,
                  fileTimestamp,
                  'videos'
                );
                console.log('✅ Video uploaded to S3.');
              } catch (uploadErr) {
                console.warn('S3 upload failed. Video kept locally.', uploadErr);
              }
            }

            // Clean up OBS recording file
            try {
              await fs.promises.unlink(data.outputPath);
            } catch (e) {
              console.warn('Could not delete OBS recording file:', e.message);
            }
          } catch (err) {
            console.error('❌ Failed during save/upload process:', err);
          }

          resolve();
        }
      };

      timeoutId = setTimeout(() => {
        obs.off('RecordStateChanged', onStopped);
        clearInterval(sizeInterval);
        console.error(`⏳ Timed out waiting for STOPPED event after ${timeoutMs}ms.`);
        resolve();
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

function shouldUploadToS3() {
  return writeToAWS && !appConfig.localOnlyStorage && awsManager;
}

function maybeWriteSessionMetadata() {
  if (sessionMetadata.getTitle() && sessionMetadata.getVideoStartTimestamp()) {
    if (shouldUploadToS3()) {
      awsManager.saveMetadata(sessionMetadata);
    }
    saveMetadataLocally();
  }
}

function saveMetadataLocally() {
  const username = sessionMetadata.getUsername();
  const fileTimestamp = sessionMetadata.getFileTimestamp();
  const localPaths = getLocalSessionPaths(username, fileTimestamp);
  
  try {
    fs.mkdirSync(localPaths.metadataDir, { recursive: true });
    fs.writeFileSync(localPaths.metadataPath, JSON.stringify(sessionMetadata, null, 2));
  } catch (err) {
    console.error('Error saving metadata locally:', err);
  }
}

function saveAnnotationLocally(annotation) {
  const username = sessionMetadata.getUsername();
  const fileTimestamp = sessionMetadata.getFileTimestamp();
  const localPaths = getLocalSessionPaths(username, fileTimestamp);
  
  try {
    fs.mkdirSync(localPaths.annotationsDir, { recursive: true });
    let annotations = [];
    if (fs.existsSync(localPaths.annotationsPath)) {
      annotations = JSON.parse(fs.readFileSync(localPaths.annotationsPath, 'utf8'));
    }
    annotations.push(annotation);
    fs.writeFileSync(localPaths.annotationsPath, JSON.stringify(annotations, null, 2));
  } catch (err) {
    console.error('Error saving annotation locally:', err);
  }
}

function registerShortcuts() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;

  globalShortcut.register(appConfig.hotkeys.annotationWindow, () => {
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

  // Emoji hotkeys
  const emojiMap = {
    emoji1: '👍',
    emoji2: '❤️',
    emoji3: '😂',
    emoji4: '😮',
    emoji5: '😢',
    emoji6: '😠',
  };

  for (const [key, emoji] of Object.entries(emojiMap)) {
    globalShortcut.register(appConfig.hotkeys[key], () => {
      if (emojiWindow) {
        emojiWindow.webContents.send('show-emoji', emoji);
      }
      if (shouldUploadToS3()) {
        awsManager.saveAnnotationToS3(sessionMetadata, { note: emoji, timestamp: Date.now() });
      }
      saveAnnotationLocally({ note: emoji, timestamp: Date.now() });
    });
  }

  globalShortcut.register(appConfig.hotkeys.quitRecording, async () => {
    console.log('Quit hotkey pressed: stopping recording');
    if (isUploading) return;
    isUploading = true;
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
    isUploading = false;
  });
}

function reRegisterShortcuts() {
  if (shortcutsRegistered) {
    globalShortcut.unregisterAll();
    shortcutsRegistered = false;
  }
  registerShortcuts();
}

async function startRecordingPhase() {
  isRecordingSetup = true;
  console.log('🎙️ Starting recording phase setup (OBS)...');
  
  try {
    await connectOBS();
    console.log('✅ OBS recording started');
    
    createNoteWindow();
    createEmojiWindow();
    
    const studyCondition = studyConditions.isEnabled() ? studyConditions.getCondition() : null;
    console.log('📋 Study condition:', studyCondition);
    if (noteWindow && !noteWindow.isDestroyed()) {
      setTimeout(() => {
        noteWindow.webContents.send('set-study-condition', studyCondition);
      }, 500);
    }
  } catch (err) {
    console.error('Error starting recording:', err);
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Recording Error',
      message: 'Failed to start OBS recording.',
      detail: err.message,
    });
  } finally {
    isRecordingSetup = false;
  }
}

async function startSession() {
  console.log('➡ User starting session flow');
  attachOBSRecordingListener();
  registerShortcuts();
  createStartWindow();
  
  // Reset session metadata
  sessionMetadata.setTitle('');
  sessionMetadata.setVideoStartTimestamp(null);
  sessionMetadata.setFileTimestamp(sessionMetadata.getFormattedTimestamp());
  
  // Start recording phase
  await startRecordingPhase();
}

async function handleHomeChoice(choice) {
  if (choice === 'start') {
    if (mainWindow) {
      try { mainWindow.close(); } catch (e) {}
      mainWindow = null;
    }
    await startSession();
  } else if (choice === 'past') {
    if (!mainWindow) createMainWindow();
    else mainWindow.show();
  }
}

// IPC Handlers
ipcMain.on('save-annotation', (event, annotation) => {
  try {
    if (shouldUploadToS3()) {
      awsManager.saveAnnotationToS3(sessionMetadata, annotation);
    }
    saveAnnotationLocally(annotation);
  } catch (err) {
    console.error('Error saving annotation:', err);
  }
});

ipcMain.on('save-start', (event, { title }) => {
  sessionMetadata.setTitle(title);
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

ipcMain.on('open-settings', () => {
  createSettingsWindow();
});

ipcMain.on('open-home', async () => {
  if (mainWindow && mainWindow.isVisible()) {
    isReturningHome = true; 
    mainWindow.close();
    mainWindow = null;
  }
  const choice = await createHomeWindow();
  await handleHomeChoice(choice);
  isReturningHome = false;
});

ipcMain.on('close-app', () => {
  console.log("Closing home");
  homeWindow.close();
  homeWindow = null;
  app.quit();
});

ipcMain.handle('get-config', async () => {
  return appConfig;
});

ipcMain.handle('set-config', async (event, newConfig) => {
  appConfig = { ...appConfig, ...newConfig };
  await writeConfig(appConfig);
});

// App event handlers
app.whenReady().then(async () => {
  console.log("A: App starting");
  isStarting = true;
  appConfig = { ...appConfig, ...(await readConfig()) };
  
  if (!sessionMetadata.getUsername()) {
    await createUsernamePrompt();
  }
  
  awsManager = new AWSManager(sessionMetadata.getUsername());
  
  try {
    await awsManager.init();
    console.log('✅ AWS S3 client initialized');
  } catch (err) {
    console.error('❌ Failed to initialize AWS S3 client:', err.message);
    console.log('⚠️ S3 operations will be unavailable.');
  }

  isStarting = false;

  const choice = await createHomeWindow();
  await handleHomeChoice(choice);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (isStarting || isRecordingSetup) {
    console.log("Still starting up, skipping quit.");
    return;
  }
  
  console.log("All windows closed, quitting app");

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
