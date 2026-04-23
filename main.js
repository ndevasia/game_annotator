const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen } = require('electron');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { spawnTracked, killAllChildren } = require("./backend/processManager.js");
const isDebug = process.argv.includes('--debug');
const path = require('path');
const AWSManager = require('./backend/aws.js');
const SessionMetadata = require('./backend/metadata.js')
const { readConfig, writeConfig } = require('./config.js');
const sessionMetadata = new SessionMetadata();
const { readUsername, writeUsername, submitUsername } = require('./username.js');
const os = require('./os.js')

let awsManager = null;

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

let ffmpegProcess = null;
let currentRecordingPath = null;
let ffmpegExecutablePath = null;
let ffmpegReady = false;
let appConfig = {
  recordAllDisplays: true,
  selectedDisplayId: null,
  localOnlyStorage: false,
  showRecentNotesOverlay: true,
  recentNotesCount: 3,
  hotkeys: {
    annotationWindow: 'CommandOrControl+Shift+N',
    showPastSessions: 'CommandOrControl+Shift+O',
    quitRecording: 'CommandOrControl+Shift+Q',
    toggleRecentNotesOverlay: 'CommandOrControl+Shift+P',
    emoji1: 'CommandOrControl+1',  // Like
    emoji2: 'CommandOrControl+2',  // Love
    emoji3: 'CommandOrControl+3',  // Haha
    emoji4: 'CommandOrControl+4',  // Wow
    emoji5: 'CommandOrControl+5',  // Sad
    emoji6: 'CommandOrControl+6',  // Angry
  },
};
let shortcutsRegistered = false;
let isUploading = false;
let isReturningHome = false;
let userQuitFromHome = false;
let isStarting = false;

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
    videoPath: path.join(userRoot, 'videos', `${fileTimestamp}.mkv`),
    metadataPath: path.join(userRoot, 'metadata', `${fileTimestamp}.json`),
    annotationsPath: path.join(userRoot, 'annotations', `${fileTimestamp}.json`),
  };
}

async function ensureLocalSessionDirs(username) {
  const paths = getLocalSessionPaths(username, sessionMetadata.getFileTimestamp());
  await Promise.all([
    fs.promises.mkdir(paths.videosDir, { recursive: true }),
    fs.promises.mkdir(paths.metadataDir, { recursive: true }),
    fs.promises.mkdir(paths.annotationsDir, { recursive: true }),
  ]);
}

function shouldUploadToS3() {
  return !appConfig.localOnlyStorage;
}

async function saveMetadataLocally() {
  const username = sessionMetadata.getUsername();
  const fileTimestamp = sessionMetadata.getFileTimestamp();
  if (!username || !fileTimestamp) return;

  await ensureLocalSessionDirs(username);
  const paths = getLocalSessionPaths(username, fileTimestamp);
  await fs.promises.writeFile(
    paths.metadataPath,
    JSON.stringify(sessionMetadata.toJSON(), null, 2),
    'utf8'
  );
}

async function saveAnnotationLocally(annotation) {
  const username = sessionMetadata.getUsername();
  const fileTimestamp = sessionMetadata.getFileTimestamp();
  if (!username || !fileTimestamp) return;

  await ensureLocalSessionDirs(username);
  const paths = getLocalSessionPaths(username, fileTimestamp);
  let annotations = [];

  try {
    const existing = await fs.promises.readFile(paths.annotationsPath, 'utf8');
    annotations = JSON.parse(existing);
    if (!Array.isArray(annotations)) {
      annotations = [];
    }
  } catch {
    annotations = [];
  }

  annotations.push(annotation);
  await fs.promises.writeFile(paths.annotationsPath, JSON.stringify(annotations, null, 2), 'utf8');

  // Send annotation to recent notes overlay if enabled and visible
  if (appConfig.showRecentNotesOverlay && recentNotesWindow && recentNotesWindow.isVisible()) {
    recentNotesWindow.webContents.send('update-recent-notes', annotation);
  }
}

async function ensureLocalAnnotationsFile() {
  const username = sessionMetadata.getUsername();
  const fileTimestamp = sessionMetadata.getFileTimestamp();
  if (!username || !fileTimestamp) return;

  await ensureLocalSessionDirs(username);
  const paths = getLocalSessionPaths(username, fileTimestamp);
  if (!fs.existsSync(paths.annotationsPath)) {
    await fs.promises.writeFile(paths.annotationsPath, JSON.stringify([], null, 2), 'utf8');
  }
}

async function cleanupLocalSession(username, fileTimestamp) {
  const paths = getLocalSessionPaths(username, fileTimestamp);
  const targets = [paths.videoPath, paths.metadataPath, paths.annotationsPath];
  await Promise.all(targets.map(async (target) => {
    if (fs.existsSync(target)) {
      await fs.promises.unlink(target);
    }
  }));
}

function parseSessionTimestamp(base) {
  const [datePart, timePart] = base.split(' ');
  if (!datePart || !timePart) return 0;
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second, millisecond] = timePart.split('-').map(Number);
  const parsed = new Date(
    year,
    (month || 1) - 1,
    day || 1,
    hour || 0,
    minute || 0,
    second || 0,
    millisecond || 0
  ).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toFileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`;
}

async function listLocalSessions(username) {
  if (!username) return [];

  const userRoot = path.join(getLocalSessionRoot(), username);
  const videosDir = path.join(userRoot, 'videos');
  const metadataDir = path.join(userRoot, 'metadata');
  const annotationsDir = path.join(userRoot, 'annotations');

  if (!fs.existsSync(videosDir) && !fs.existsSync(metadataDir) && !fs.existsSync(annotationsDir)) {
    return [];
  }

  const [videoFiles, metadataFiles, annotationFiles] = await Promise.all([
    fs.existsSync(videosDir)
      ? fs.promises.readdir(videosDir).then((items) => items.filter((name) => name.endsWith('.mkv')))
      : Promise.resolve([]),
    fs.existsSync(metadataDir)
      ? fs.promises.readdir(metadataDir).then((items) => items.filter((name) => name.endsWith('.json')))
      : Promise.resolve([]),
    fs.existsSync(annotationsDir)
      ? fs.promises.readdir(annotationsDir).then((items) => items.filter((name) => name.endsWith('.json')))
      : Promise.resolve([]),
  ]);

  const sessionTimestamps = new Set();
  videoFiles.forEach((name) => sessionTimestamps.add(name.replace(/\.mkv$/, '')));
  metadataFiles.forEach((name) => sessionTimestamps.add(name.replace(/\.json$/, '')));
  annotationFiles.forEach((name) => sessionTimestamps.add(name.replace(/\.json$/, '')));

  const sessions = [];

  for (const fileTimestamp of sessionTimestamps) {
    const metadataPath = path.join(metadataDir, `${fileTimestamp}.json`);
    const annotationPath = path.join(annotationsDir, `${fileTimestamp}.json`);
    const videoPath = path.join(videosDir, `${fileTimestamp}.mkv`);

    const hasVideo = fs.existsSync(videoPath);
    const hasMetadata = fs.existsSync(metadataPath);
    const hasAnnotations = fs.existsSync(annotationPath);
    if (!hasVideo && !hasMetadata && !hasAnnotations) continue;

    let metadataObj = {};
    if (hasMetadata) {
      try {
        metadataObj = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
      } catch {
        metadataObj = {};
      }
    }

    sessions.push({
      title: metadataObj.title || 'Session',
      videoStartTimestamp: metadataObj.videoStartTimestamp || parseSessionTimestamp(fileTimestamp),
      videoUrl: hasVideo ? toFileUrl(videoPath) : null,
      annotationPath,
      isLocalOnly: true,
      hasVideo,
      hasMetadata,
      hasAnnotations,
      isInProgress: hasMetadata && !hasVideo,
      username,
      fileTimestamp,
    });
  }

  return sessions;
}

async function uploadLocalSession(username, fileTimestamp) {
  const paths = getLocalSessionPaths(username, fileTimestamp);
  if (!fs.existsSync(paths.videoPath) || !fs.existsSync(paths.metadataPath)) {
    throw new Error('Local session files are incomplete.');
  }

  const [videoBuffer, metadataBuffer] = await Promise.all([
    fs.promises.readFile(paths.videoPath),
    fs.promises.readFile(paths.metadataPath),
  ]);

  let annotationsBuffer;
  if (fs.existsSync(paths.annotationsPath)) {
    annotationsBuffer = await fs.promises.readFile(paths.annotationsPath);
  } else {
    annotationsBuffer = Buffer.from(JSON.stringify([], null, 2));
  }

  await awsManager.uploadFile(videoBuffer, username, fileTimestamp, 'videos');
  await awsManager.uploadFile(metadataBuffer, username, fileTimestamp, 'metadata');
  await awsManager.uploadFile(annotationsBuffer, username, fileTimestamp, 'annotations');

  await cleanupLocalSession(username, fileTimestamp);
}

async function deleteLocalSession(username, fileTimestamp) {
  if (!username || !fileTimestamp) {
    throw new Error('Username and fileTimestamp are required to delete local sessions.');
  }
  await cleanupLocalSession(username, fileTimestamp);
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
      writeUsername(username);
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

  mainWindow.on('close', (e) => {
    // If the app is in the middle of uploading, don't show the box
    if (isUploading || isReturningHome || userQuitFromHome) return;

    // Prevent the window from closing immediately
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
      console.log("User confirmed quit from main window");
      userQuitFromHome = true;
      app.quit(); 
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function closeAllIndexWindows() {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    const currentUrl = win.webContents.getURL() || '';
    if (currentUrl.endsWith('/index.html') || currentUrl.includes('/index.html?')) {
      try {
        win.destroy();
      } catch (err) {
        console.warn('Failed to close an index window:', err);
      }
    }
  }
  mainWindow = null;
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

function createRecentNotesWindow() {
  if (recentNotesWindow) return;

  // Calculate position for bottom-right corner
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const windowWidth = 370;
  const windowHeight = 330;
  const padding = 20;
  const x = Math.floor(screenWidth - windowWidth - padding);
  const y = Math.floor(screenHeight - windowHeight - padding);

  recentNotesWindow = new BrowserWindow({
    x: x,
    y: y,
    width: 370,
    height: 330,
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

  recentNotesWindow.loadFile('recent-notes.html');

  recentNotesWindow.once('ready-to-show', () => {
    console.log('Recent notes overlay ready');
  });

  recentNotesWindow.setIgnoreMouseEvents(true, { forward: true });

  recentNotesWindow.on('closed', () => {
    recentNotesWindow = null;
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
      width: 600,
      height: 500,
      alwaysOnTop: true,
      transparent: true,
      frame: false,
      resizable: true,
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


function getFFMpegPlatform() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

function resolveFFMpegPath() {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const platform = getFFMpegPlatform();
  const arch = process.arch;
  const appPath = app.getAppPath();

  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(appPath, '..', 'bin', platform, arch, binaryName),
    path.join(process.resourcesPath || '', 'bin', platform, arch, binaryName),
    path.join(appPath, 'bin', platform, arch, binaryName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log('Using FFMPEG binary:', candidate);
      return candidate;
    }
  }

  console.log('Using system FFMPEG from PATH');
  return binaryName;
}

function checkFFMpegAvailable() {
  const candidate = resolveFFMpegPath();
  const result = spawnSync(candidate, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      path: candidate,
      details: result.error ? result.error.message : result.stderr.toString().trim(),
    };
  }

  return {
    available: true,
    path: candidate,
    details: '',
  };
}

function showFFMpegMissingDialog(details = '') {
  const extraDetails = details ? `\n\nTechnical details:\n${details}` : '';
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    buttons: ['Quit App', 'Continue (Past Sessions Only)'],
    defaultId: 0,
    cancelId: 0,
    title: 'FFMPEG Not Found',
    message: 'FFMPEG is required to record new sessions.',
    detail: `The app could not find a working FFMPEG binary. You can continue to view past sessions only, or quit and install/configure FFMPEG.${extraDetails}`,
  });

  return choice === 1;
}

function parseMacCaptureDevice(ffmpegPath) {
  const ffmpegResult = spawnSync(
    ffmpegPath,
    ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '""'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const lines = ffmpegResult.stderr.toString().split('\n');
  const screenLine = lines.find((line) => {
    const lower = line.toLowerCase();
    return lower.includes('capture screen') || lower.includes('screen');
  });

  if (!screenLine) {
    return '1:none';
  }

  const match = screenLine.match(/\[(\d+)\]/);
  if (!match) {
    return '1:none';
  }

  return `${match[1]}:none`;
}

function getDisplayCaptureConfig() {
  if (appConfig.recordAllDisplays) {
    return {
      input: 'desktop',
      size: null,
      offsetX: null,
      offsetY: null,
    };
  }

  const configuredDisplay = appConfig.selectedDisplayId !== null
    ? screen.getAllDisplays().find((display) => String(display.id) === String(appConfig.selectedDisplayId))
    : null;
  const cursorPoint = screen.getCursorScreenPoint();
  const activeDisplay = configuredDisplay || screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay();
  const displayBounds = process.platform === 'win32'
    ? screen.dipToScreenRect(null, activeDisplay.bounds)
    : activeDisplay.bounds;
  const { x, y, width, height } = displayBounds;

  console.log(`Recording single display: ${activeDisplay.label || activeDisplay.id} at ${width}x${height} (${x}, ${y})`);

  return {
    input: 'desktop',
    size: `${width}x${height}`,
    offsetX: String(x),
    offsetY: String(y),
  };
}

function getFFMpegRecordingArgs(ffmpegPath, outputPath) {
  const args = ['-hide_banner', '-y'];

  if (process.platform === 'win32') {
    const captureConfig = getDisplayCaptureConfig();
    args.push(
      '-f', 'gdigrab',
      '-framerate', '30',
    );

    if (captureConfig.offsetX !== null && captureConfig.offsetY !== null && captureConfig.size) {
      args.push(
        '-offset_x', captureConfig.offsetX,
        '-offset_y', captureConfig.offsetY,
        '-video_size', captureConfig.size
      );
    }

    args.push(
      '-i', captureConfig.input
    );
  } else if (process.platform === 'darwin') {
    const captureDevice = parseMacCaptureDevice(ffmpegPath);
    args.push(
      '-f', 'avfoundation',
      '-framerate', '30',
      '-i', captureDevice
    );
  } else {
    args.push(
      '-f', 'x11grab',
      '-framerate', '30',
      '-i', process.env.DISPLAY || ':0.0'
    );
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    outputPath
  );

  return args;
}

async function startFFMpegRecording() {
  if (ffmpegProcess) {
    console.log('FFMPEG recording already active');
    return;
  }

  const recordingsDir = path.join(app.getPath('temp'), 'game_annotator_recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });

  const ffmpegPath = ffmpegExecutablePath || resolveFFMpegPath();
  currentRecordingPath = path.join(recordingsDir, `recording_${Date.now()}.mp4`);
  const args = getFFMpegRecordingArgs(ffmpegPath, currentRecordingPath);

  console.log('Starting FFMPEG recording');
  if (isDebug) {
    console.log('FFMPEG command:', ffmpegPath, args.join(' '));
  }

  await new Promise((resolve, reject) => {
    let started = false;
    const timeoutId = setTimeout(() => {
      if (started) return;
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
      }
      reject(new Error('FFMPEG did not start recording in time'));
    }, 15000);

    ffmpegProcess = spawnTracked(ffmpegPath, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });

    ffmpegProcess.once('error', (err) => {
      clearTimeout(timeoutId);
      ffmpegProcess = null;
      reject(new Error(`Failed to start FFMPEG: ${err.message}`));
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const text = data.toString();
      if (isDebug) {
        console.log(`FFMPEG: ${text.trim()}`);
      }
      if (!started && (text.includes('Press [q] to stop') || text.includes('frame='))) {
        started = true;
        clearTimeout(timeoutId);
        resolve();
      }
    });

    ffmpegProcess.once('exit', (code) => {
      if (!started) {
        clearTimeout(timeoutId);
        ffmpegProcess = null;
        reject(new Error(`FFMPEG exited before startup with code ${code}`));
      }
    });
  });

  sessionMetadata.setVideoStartTimestamp(Date.now());
  maybeWriteSessionMetadata();
  console.log('FFMPEG recording started');
}


async function stopFFMpegRecording(timeoutMs = 600000) {
  if (!ffmpegProcess) {
    console.log('No active FFMPEG recording to stop.');
    return;
  }

  const processToStop = ffmpegProcess;
  const recordingPath = currentRecordingPath;

  ffmpegProcess = null;
  currentRecordingPath = null;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;

      const sizeInterval = setInterval(() => {
        if (!recordingPath) return;
        try {
          const stats = fs.statSync(recordingPath);
          console.log(`Writing file... ${Math.round(stats.size / (1024 * 1024))} MB`);
        } catch (e) {
          // file may not exist yet while ffmpeg is still flushing
        }
      }, 2000);

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(sizeInterval);
        try {
          processToStop.kill('SIGKILL');
        } catch (e) {}
        reject(new Error(`Timed out waiting for FFMPEG to stop after ${timeoutMs}ms.`));
      }, timeoutMs);

      processToStop.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        clearInterval(sizeInterval);

        if (code !== 0 && code !== null) {
          console.warn(`FFMPEG exited with code ${code} while stopping.`);
        }
        resolve();
      });

      processToStop.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        clearInterval(sizeInterval);
        reject(err);
      });

      try {
        processToStop.stdin.write('q\n');
      } catch (err) {
        try {
          processToStop.kill('SIGKILL');
        } catch (killErr) {}
      }
    });

    if (!recordingPath || !fs.existsSync(recordingPath)) {
      console.warn('Recording ended but no output file was found.');
      return;
    }

    const username = sessionMetadata.getUsername();
    const fileTimestamp = sessionMetadata.getFileTimestamp();
    await ensureLocalSessionDirs(username);
    await saveMetadataLocally();
    await ensureLocalAnnotationsFile();

    const localPaths = getLocalSessionPaths(username, fileTimestamp);
    await fs.promises.rename(recordingPath, localPaths.videoPath).catch(async (renameErr) => {
      if (renameErr && renameErr.code === 'EXDEV') {
        await fs.promises.copyFile(recordingPath, localPaths.videoPath);
        await fs.promises.unlink(recordingPath);
        return;
      }
      throw renameErr;
    });

    if (!shouldUploadToS3()) {
      console.log(`Stored session locally only: ${localPaths.videoPath}`);
      return;
    }

    try {
      const [videoBuffer, metadataBuffer, annotationsBuffer] = await Promise.all([
        fs.promises.readFile(localPaths.videoPath),
        fs.promises.readFile(localPaths.metadataPath),
        fs.promises.readFile(localPaths.annotationsPath),
      ]);

      await awsManager.uploadFile(videoBuffer, username, fileTimestamp, 'videos');
      await awsManager.uploadFile(metadataBuffer, username, fileTimestamp, 'metadata');
      await awsManager.uploadFile(annotationsBuffer, username, fileTimestamp, 'annotations');

      await cleanupLocalSession(username, fileTimestamp);
      console.log('Session uploaded to S3 and local copies removed.');
    } catch (uploadError) {
      console.warn('S3 upload failed. Keeping session locally for later upload.', uploadError);
    }
  } catch (error) {
    console.error('Failed during FFMPEG stop/upload process:', error);
    throw error;
  }
}

function stopFFMpegIfRunning() {
  if (!ffmpegProcess) {
    return;
  }

  try {
    ffmpegProcess.kill('SIGKILL');
  } catch (err) {
    console.warn('Error force-killing FFMPEG process:', err);
  } finally {
    ffmpegProcess = null;
    currentRecordingPath = null;
  }
}

function reRegisterShortcuts() {
  if (shortcutsRegistered) {
    globalShortcut.unregisterAll();
    shortcutsRegistered = false;
  }
  registerShortcuts();
}

function registerShortcuts() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;

  const emojiMap = {
    'emoji1': '👍',  // Like
    'emoji2': '❤️',  // Love
    'emoji3': '😂',  // Haha
    'emoji4': '😮',  // Wow
    'emoji5': '😢',  // Sad
    'emoji6': '😠',  // Angry
  };

  const hotkeyConfig = appConfig.hotkeys || {};

  globalShortcut.register(hotkeyConfig.annotationWindow || 'CommandOrControl+Shift+N', () => {
    focusedWindow = os.getFocusedWindow();
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

  globalShortcut.register(hotkeyConfig.showPastSessions || 'CommandOrControl+Shift+O', () => {
    if (!mainWindow) {
      createMainWindow();
      return;
    }

    mainWindow.show();
    mainWindow.focus();
    if (!mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('session-data', sessionMetadata.getUsername());
    }
  });

  for (let i = 1; i <= 6; i++) {
    const hotkeyKey = `emoji${i}`;
    const hotkey = hotkeyConfig[hotkeyKey];
    const emoji = emojiMap[hotkeyKey];
    
    if (hotkey) {
      globalShortcut.register(hotkey, () => {
        if (emojiWindow) {
          emojiWindow.webContents.send('show-emoji', emoji);
        }
        saveAnnotationLocally({ note: emoji, timestamp: Date.now() }).catch((err) => {
          console.error('Error saving emoji annotation locally:', err);
        });
      });
    }
  }

  globalShortcut.register(hotkeyConfig.toggleRecentNotesOverlay || 'CommandOrControl+Shift+P', () => {
    if (recentNotesWindow) {
      if (recentNotesWindow.isVisible()) {
        recentNotesWindow.hide();
      } else {
        recentNotesWindow.show();
      }
    }
  });

  globalShortcut.register(hotkeyConfig.quitRecording || 'CommandOrControl+Shift+Q', async () => {
    console.log('Quit hotkey pressed: stopping recording');
    if (isUploading) return;
    isUploading = true;
    try {
      createLoadingWindow();
      await stopFFMpegRecording();
    } catch (err) {
      console.error('Error during FFMPEG shutdown:', err);
    } finally {
      closeLoadingWindow();
    }
    if (noteWindow) {
      noteWindow.close();
    }
    if (recentNotesWindow) {
      recentNotesWindow.close();
    }
    closeAllIndexWindows();
    createMainWindow();
    isUploading = false;
  });
}

async function startSession() {
  console.log('➡ User starting session flow');
  if (!ffmpegReady) {
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Recording Unavailable',
      message: 'Cannot start a new session because FFMPEG is not available.',
      detail: 'Install/configure FFMPEG and restart the app.',
    });
    return;
  }

  // Reset per-session metadata so files are never reused across recordings.
  sessionMetadata.setTitle('');
  sessionMetadata.setVideoStartTimestamp(null);
  sessionMetadata.setFileTimestamp(sessionMetadata.getFormattedTimestamp());

  registerShortcuts();
  createStartWindow();
  await startFFMpegRecording();
  createNoteWindow();        // open overlay window
  createEmojiWindow();
  
  // Create and show recent notes overlay if enabled
  if (appConfig.showRecentNotesOverlay) {
    createRecentNotesWindow();
    if (recentNotesWindow) {
      recentNotesWindow.show();
      // Send the configured message count to the overlay
      const count = appConfig.recentNotesCount || 3;
      recentNotesWindow.webContents.send('set-notes-display-count', count);
      // Send the video start timestamp for relative time calculations
      const videoStart = sessionMetadata.getVideoStartTimestamp();
      recentNotesWindow.webContents.send('set-video-start-time', videoStart);
    }
  }
}

async function saveSettings(partialSettings) {
  const oldHotkeys = appConfig.hotkeys;
  appConfig = { ...appConfig, ...partialSettings };
  await writeConfig(appConfig);
  
  // If hotkeys have changed, re-register them
  if (oldHotkeys && JSON.stringify(oldHotkeys) !== JSON.stringify(appConfig.hotkeys)) {
    reRegisterShortcuts();
  }
}

function getAvailableDisplays() {
  const displays = screen.getAllDisplays();
  const fallbackDisplays = displays.length ? displays : [screen.getPrimaryDisplay()].filter(Boolean);

  return fallbackDisplays.map((display, index) => ({
    id: String(display.id),
    label: display.label || `Display ${index + 1}`,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    internal: Boolean(display.internal),
  }));
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
  isStarting = true;
  appConfig = { ...appConfig, ...(await readConfig()) };
  if (!sessionMetadata.getUsername()) {
    await createUsernamePrompt();
  }
  awsManager = new AWSManager(sessionMetadata.getUsername());
  await awsManager.init();

  const ffmpegCheck = checkFFMpegAvailable();
  ffmpegReady = ffmpegCheck.available;
  ffmpegExecutablePath = ffmpegCheck.path;
  if (ffmpegReady) {
    console.log(`FFMPEG ready at: ${ffmpegExecutablePath}`);
  } else {
    console.error(`FFMPEG check failed for path: ${ffmpegExecutablePath}`);
    if (ffmpegCheck.details) {
      console.error(`FFMPEG details: ${ffmpegCheck.details}`);
    }

    const continueWithoutRecording = showFFMpegMissingDialog(ffmpegCheck.details);
    if (!continueWithoutRecording) {
      app.quit();
      return;
    }
  }

  isStarting = false;

  // Blocking prompt at startup:
  const choice = await createHomeWindow();
  await handleHomeChoice(choice);
  });

  ipcMain.on('save-annotation', (event, annotation) => {
    try {
      saveAnnotationLocally(annotation).catch((err) => {
        console.error('Error saving annotation locally:', err);
      });
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
      if (focusedWindow != null) {
        os.setFocusedWindow(focusedWindow);
      }
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
  ipcMain.on('open-settings', () => {
    createSettingsWindow();
  });
  ipcMain.on('close-settings', () => {
    if (settingsWindow) {
      settingsWindow.close();
    }
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
  ipcMain.on('hide-username', () => {
    if (usernamePromptWindow && usernamePromptWindow.isVisible()) {
      usernamePromptWindow.close();
    }
  });
  ipcMain.handle('get-video-start', () => {
    return sessionMetadata.getVideoStartTimestamp();
    });
  ipcMain.handle('get-settings', () => {
    return appConfig;
  });
  ipcMain.handle('get-available-displays', () => {
    return getAvailableDisplays();
  });
  ipcMain.handle('save-settings', async (event, settings) => {
    await saveSettings(settings);
    return appConfig;
  });
  ipcMain.handle('get-local-sessions', async (event, username) => {
    return listLocalSessions(username);
  });
  ipcMain.handle('upload-local-session', async (event, { username, fileTimestamp }) => {
    if (!username || !fileTimestamp) {
      throw new Error('Username and fileTimestamp are required to upload local sessions.');
    }
    await uploadLocalSession(username, fileTimestamp);
    return { success: true };
  });
  ipcMain.handle('delete-local-session', async (event, { username, fileTimestamp }) => {
    await deleteLocalSession(username, fileTimestamp);
    return { success: true };
  });
  ipcMain.handle('download-local-session', async (event, { username, fileTimestamp }) => {
    const paths = getLocalSessionPaths(username, fileTimestamp);
    const result = await dialog.showSaveDialog(homeWindow, {
      title: 'Download Session Files',
      defaultPath: `session_${fileTimestamp}`,
      properties: ['createDirectory']
    });

    if (result.canceled) {
      return { success: false, reason: 'User canceled' };
    }

    const destDir = result.filePath;
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
      
      if (fs.existsSync(paths.videoPath)) {
        await fs.promises.copyFile(paths.videoPath, path.join(destDir, `${fileTimestamp}.mkv`));
      }
      if (fs.existsSync(paths.metadataPath)) {
        await fs.promises.copyFile(paths.metadataPath, path.join(destDir, `${fileTimestamp}_metadata.json`));
      }
      if (fs.existsSync(paths.annotationsPath)) {
        await fs.promises.copyFile(paths.annotationsPath, path.join(destDir, `${fileTimestamp}_annotations.json`));
      }
      
      return { success: true };
    } catch (err) {
      console.error('Error downloading session files:', err);
      throw err;
    }
  });
  ipcMain.handle('download-s3-session', async (event, { username, fileTimestamp }) => {
    if (!awsManager) {
      throw new Error('AWS Manager not initialized');
    }

    const result = await dialog.showSaveDialog(homeWindow, {
      title: 'Download Session Files from Cloud',
      defaultPath: `session_${fileTimestamp}`,
      properties: ['createDirectory']
    });

    if (result.canceled) {
      return { success: false, reason: 'User canceled' };
    }

    const destDir = result.filePath;
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
      
      const videoKey = `${username}/videos/${fileTimestamp}.mkv`;
      const metadataKey = `${username}/metadata/${fileTimestamp}.json`;
      const annotationsKey = `${username}/annotations/${fileTimestamp}.json`;

      try {
        const videoBuffer = await awsManager.getFileFromS3(videoKey);
        await fs.promises.writeFile(path.join(destDir, `${fileTimestamp}.mkv`), videoBuffer);
      } catch (err) {
        console.warn('Video file not found in S3, continuing...');
      }

      try {
        const metadataBuffer = await awsManager.getFileFromS3(metadataKey);
        await fs.promises.writeFile(path.join(destDir, `${fileTimestamp}_metadata.json`), metadataBuffer);
      } catch (err) {
        console.warn('Metadata file not found in S3, continuing...');
      }

      try {
        const annotationsBuffer = await awsManager.getFileFromS3(annotationsKey);
        await fs.promises.writeFile(path.join(destDir, `${fileTimestamp}_annotations.json`), annotationsBuffer);
      } catch (err) {
        console.warn('Annotations file not found in S3, continuing...');
      }
      
      return { success: true };
    } catch (err) {
      console.error('Error downloading S3 session files:', err);
      throw err;
    }
  });
  ipcMain.on('close-app', () => {
    console.log("Closing home");
    homeWindow.close();
    homeWindow = null;
    app.quit();
  });
  function maybeWriteSessionMetadata() {
    if (sessionMetadata.getTitle() && sessionMetadata.getVideoStartTimestamp()) {
      saveMetadataLocally().catch((err) => {
        console.error('Error saving metadata locally:', err);
      });
    }
  }

  app.on('will-quit', () => {
    stopFFMpegIfRunning();
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    // If we are currently in the middle of the startup flow (switching windows)
    
    if (isStarting) {
      console.log("Still starting up, skipping quit.");
      return;
    }
    console.log("All windows closed, quitting app");

    // or if we are on macOS, don't quit the app.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
