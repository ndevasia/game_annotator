const { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen } = require('electron');
console.log('🚀 main.js starting to load...');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { spawnTracked, killAllChildren } = require("./backend/processManager.js");
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

let ffmpegProcess = null;
let currentRecordingPath = null;
let ffmpegExecutablePath = null;
let ffmpegReady = false;
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
    emoji1: 'CommandOrControl+Shift+1',  // Like
    emoji2: 'CommandOrControl+Shift+2',  // Love
    emoji3: 'CommandOrControl+Shift+3',  // Haha
    emoji4: 'CommandOrControl+Shift+4',  // Wow
    emoji5: 'CommandOrControl+Shift+5',  // Sad
    emoji6: 'CommandOrControl+Shift+6',  // Angry
  },
};
let shortcutsRegistered = false;
let isUploading = false;
let isReturningHome = false;
let userQuitFromHome = false;
let isNavigatingFromHome = false;
let isStarting = false;
let isRecordingSetup = false;

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
    chatPath: path.join(userRoot, 'chats', `${fileTimestamp}.json`),
  };
}

async function ensureLocalSessionDirs(username) {
  const paths = getLocalSessionPaths(username, sessionMetadata.getFileTimestamp());
  await Promise.all([
    fs.promises.mkdir(paths.videosDir, { recursive: true }),
    fs.promises.mkdir(paths.metadataDir, { recursive: true }),
    fs.promises.mkdir(paths.annotationsDir, { recursive: true }),
    fs.promises.mkdir(paths.chatsDir, { recursive: true }),
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

  // Send annotation to recent notes overlay whenever it exists, even if hidden.
  if (
    appConfig.showRecentNotesOverlay &&
    recentNotesWindow &&
    !recentNotesWindow.isDestroyed() &&
    recentNotesWindow.webContents &&
    !recentNotesWindow.webContents.isDestroyed()
  ) {
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

async function saveChatTranscript(username, fileTimestamp, transcript, gameTitle) {
  try {
    await ensureLocalSessionDirs(username);
    const paths = getLocalSessionPaths(username, fileTimestamp);
    
    const chatData = {
      gameTitle: gameTitle,
      timestamp: Date.now(),
      messages: transcript
    };
    
    console.log('💾 Saving chat transcript:', { username, fileTimestamp, messageCount: transcript.length });
    await fs.promises.writeFile(paths.chatPath, JSON.stringify(chatData, null, 2), 'utf8');
    console.log('✅ Chat transcript saved to:', paths.chatPath);
  } catch (err) {
    console.error('❌ Error saving chat transcript:', err);
  }
}

async function loadChatTranscript(username, fileTimestamp) {
  try {
    const paths = getLocalSessionPaths(username, fileTimestamp);
    console.log('📖 Loading chat transcript from:', paths.chatPath);
    const chatContent = await fs.promises.readFile(paths.chatPath, 'utf8');
    console.log('✅ Chat transcript loaded successfully');
    return JSON.parse(chatContent);
  } catch (err) {
    console.warn('⚠️ Chat file not found or error reading:', err.message);
    return null;
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

    const isActiveRecording = Boolean(ffmpegProcess) && fileTimestamp === sessionMetadata.getFileTimestamp();

    sessions.push({
      title: metadataObj.title || 'Session',
      videoStartTimestamp: metadataObj.videoStartTimestamp || parseSessionTimestamp(fileTimestamp),
      postGameReview: metadataObj.postGameReview || '',
      postGameReviewSavedAt: metadataObj.postGameReviewSavedAt || null,
      postGameReviewLastEditedAt: metadataObj.postGameReviewLastEditedAt || null,
      postGameReviewCondition: metadataObj.postGameReviewCondition || null,
      videoUrl: hasVideo ? toFileUrl(videoPath) : null,
      annotationPath,
      isLocalOnly: true,
      hasVideo,
      hasMetadata,
      hasAnnotations,
      // A session is only "live" if it matches the currently active recorder output.
      isInProgress: isActiveRecording && hasMetadata && !hasVideo,
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

async function updateLocalSessionReview(username, fileTimestamp, review) {
  if (!username || !fileTimestamp) {
    throw new Error('Username and fileTimestamp are required to update local session review.');
  }

  await ensureLocalSessionDirs(username);
  const paths = getLocalSessionPaths(username, fileTimestamp);

  let metadataObj = {
    username,
    title: 'Session',
    fileTimestamp,
    videoStartTimestamp: parseSessionTimestamp(fileTimestamp),
  };

  if (fs.existsSync(paths.metadataPath)) {
    try {
      const existing = await fs.promises.readFile(paths.metadataPath, 'utf8');
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object') {
        metadataObj = { ...metadataObj, ...parsed };
      }
    } catch {
      // Keep fallback metadata object if existing file is unreadable.
    }
  }

  metadataObj.postGameReview = review || '';
  if (metadataObj.postGameReview) {
    const now = Date.now();
    if (!metadataObj.postGameReviewSavedAt) {
      metadataObj.postGameReviewSavedAt = now;
    }
    metadataObj.postGameReviewLastEditedAt = now;
  } else {
    metadataObj.postGameReviewSavedAt = null;
    metadataObj.postGameReviewLastEditedAt = null;
  }
  await fs.promises.writeFile(paths.metadataPath, JSON.stringify(metadataObj, null, 2), 'utf8');
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

function createPostGameReviewWindow() {
  return new Promise((resolve) => {
    if (reviewWindow && !reviewWindow.isDestroyed()) {
      reviewWindow.focus();
      resolve('');
      return;
    }

    reviewWindow = new BrowserWindow({
      width: 860,
      height: 600,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: true,
      movable: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      }
    });

    // Load the appropriate review file based on study condition
    // AI review only appears in study mode with 'prompt-ai' condition
    let reviewFile = 'review-text.html'; // default
    if (studyConditions.isEnabled()) {
      if (studyConditions.shouldShowAIReview()) {
        reviewFile = 'review-ai.html';
      } else if (studyConditions.shouldShowTextReview()) {
        reviewFile = 'review-text.html';
      }
    }
    // In normal mode, always use text review (never AI)
    reviewWindow.loadFile(reviewFile);

    reviewWindow.once('ready-to-show', () => {
      if (reviewWindow) {
        // Send session metadata and annotations to renderer
        try {
          const paths = getLocalSessionPaths(sessionMetadata.getUsername(), sessionMetadata.getFileTimestamp());
          let annotations = '';

          if (fs.existsSync(paths.annotationsPath)) {
            try {
              const annotationsData = JSON.parse(fs.readFileSync(paths.annotationsPath, 'utf8'));
              if (Array.isArray(annotationsData)) {
                annotations = annotationsData.map(a => a.text || a).join(' | ');
              }
            } catch (err) {
              console.warn('Could not read annotations:', err);
            }
          }

          reviewWindow.webContents.send('session-data', {
            gameTitle: sessionMetadata.getTitle(),
            username: sessionMetadata.getUsername(),
            annotations: annotations,
            geminiAvailable: geminiService !== null,
            reviewMode: appConfig.reviewMode,
            studyMetadata: sessionMetadata.studyMetadata || {}  // Include mood/mind context
          });
        } catch (err) {
          console.error('Error sending session data:', err);
        }

        reviewWindow.show();
        reviewWindow.focus();
      }
    });

    const cleanup = () => {
      ipcMain.removeListener('post-game-review-submitted', onSubmitted);
      ipcMain.removeListener('post-game-review-window-closed', onClosedWithoutSubmit);
      ipcMain.removeListener('generate-initial-questions', onGenerateQuestions);
      ipcMain.removeListener('send-chat-message', onChatMessage);
    };

    const resolveAndClose = (reviewText) => {
      cleanup();
      if (geminiService) {
        geminiService.resetConversation();
      }
      if (reviewWindow && !reviewWindow.isDestroyed()) {
        reviewWindow.close();
      }
      reviewWindow = null;
      
      // Advance study session after review is complete
      if (studyConditions.isEnabled() && reviewText !== undefined) {
        studyConditions.advanceSession();
        const newSession = studyConditions.getSessionNumber() + 1;
        const isComplete = studyConditions.isStudyComplete();
        console.log(`📋 Session completed. Progress: ${newSession}/6`);
        if (isComplete) {
          console.log(`✅ Study complete! All 6 sessions have been finished.`);
        }
      }
      
      resolve(reviewText || '');
    };

    const onSubmitted = (event, reviewText) => {
      resolveAndClose(reviewText);
    };

    const onClosedWithoutSubmit = () => {
      resolveAndClose('');
    };

    const onGenerateQuestions = async (event, { gameTitle, annotations, studyContext }) => {
      if (!geminiService) {
        event.reply('initial-question-ready', {
          error: 'Gemini service not available'
        });
        return;
      }

      try {
        const question = await geminiService.initializeAndGetFirstQuestion(gameTitle, annotations, studyContext);
        event.reply('initial-question-ready', { question });
      } catch (err) {
        console.error('Error generating first question:', err);
        event.reply('initial-question-ready', {
          error: err.message
        });
      }
    };

    const onChatMessage = async (event, { userMessage, gameTitle }) => {
      if (!geminiService) {
        event.reply('chat-message-received', {
          error: 'Gemini service not available'
        });
        return;
      }

      try {
        const result = await geminiService.sendMessageAndGetNextQuestion(userMessage);
        event.reply('chat-message-received', result);
      } catch (err) {
        console.error('Error in chat:', err);
        event.reply('chat-message-received', {
          error: err.message
        });
      }
    };

    ipcMain.once('post-game-review-submitted', onSubmitted);
    ipcMain.once('post-game-review-window-closed', onClosedWithoutSubmit);
    ipcMain.on('generate-initial-questions', onGenerateQuestions);
    ipcMain.on('send-chat-message', onChatMessage);

    reviewWindow.on('closed', () => {
      cleanup();
      reviewWindow = null;
      resolve('');
    });
  });
}

function createSessionChatWindow(gameTitle, username, fileTimestamp) {
  return new Promise((resolve) => {
    console.log('Creating session chat window for:', gameTitle);
    let chatWindow = new BrowserWindow({
      width: 860,
      height: 600,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: true,
      movable: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      }
    });

    chatWindow.loadFile('review-ai.html');

    // Create a separate Gemini service instance for this chat session
    let sessionGeminiService = null;
    try {
      sessionGeminiService = new GeminiService();
      console.log('✅ Created separate Gemini service for this chat session');
    } catch (err) {
      console.warn('⚠️ Could not create Gemini service for chat session:', err.message);
    }

    // Define IPC handlers for this chat window
    const onGenerateQuestions = async (event, { gameTitle, annotations }) => {
      if (!sessionGeminiService) {
        event.reply('initial-question-ready', {
          error: 'Gemini service not available'
        });
        return;
      }

      try {
        console.log('🔵 Generating initial question for session chat...');
        const question = await sessionGeminiService.initializeAndGetFirstQuestion(gameTitle, annotations);
        console.log('🔵 Question generated:', question);
        event.reply('initial-question-ready', { question });
      } catch (err) {
        console.error('❌ Error generating first question:', err);
        event.reply('initial-question-ready', {
          error: err.message
        });
      }
    };

    const onChatMessage = async (event, { userMessage, gameTitle }) => {
      if (!sessionGeminiService) {
        event.reply('chat-message-received', {
          error: 'Gemini service not available'
        });
        return;
      }

      try {
        console.log('🔵 Processing chat message in session chat...');
        const result = await sessionGeminiService.sendMessageAndGetNextQuestion(userMessage);
        console.log('🔵 Chat response ready:', result);
        event.reply('chat-message-received', result);
      } catch (err) {
        console.error('❌ Error in session chat:', err);
        event.reply('chat-message-received', {
          error: err.message
        });
      }
    };

    chatWindow.once('ready-to-show', () => {
      console.log('🟢 Chat window ready to show');
      if (chatWindow) {
        // Send session data to renderer for chat-only mode
        chatWindow.webContents.send('session-data', {
          gameTitle: gameTitle,
          username: username,
          fileTimestamp: fileTimestamp,
          annotations: '',
          geminiAvailable: sessionGeminiService !== null,
          isChatOnly: true
        });

        chatWindow.show();
        chatWindow.focus();
        console.log('🟢 Chat window displayed');
      }
    });

    // Register handlers for this window
    ipcMain.on('generate-initial-questions', onGenerateQuestions);
    ipcMain.on('send-chat-message', onChatMessage);

    const cleanup = () => {
      console.log('🔵 Cleaning up session chat handlers');
      ipcMain.removeListener('generate-initial-questions', onGenerateQuestions);
      ipcMain.removeListener('send-chat-message', onChatMessage);
      ipcMain.removeListener('post-game-review-window-closed', onChatClosed);
      // Clean up this session's Gemini service
      sessionGeminiService = null;
    };

    const onChatClosed = () => {
      console.log('🔵 Session chat closed (close button clicked)');
      cleanup();
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.close();
      }
      chatWindow = null;
      // Return focus to mainWindow
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
      }
      resolve();
    };

    const onClosed = () => {
      console.log('🔵 Chat window closed');
      cleanup();
      chatWindow = null;
      // Return focus to mainWindow
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
      }
      resolve();
    };

    ipcMain.once('post-game-review-window-closed', onChatClosed);
    chatWindow.on('closed', onClosed);
  });
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
    width: 900,
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
    const studyCondition = studyConditions.isEnabled() ? studyConditions.getCondition() : null;
    mainWindow.webContents.send('session-data', {
      username: sessionMetadata.getUsername(),
      studyCondition,
      studyMode: studyConditions.isEnabled()
    });
  });

  mainWindow.on('close', async (e) => {
    console.log('🔴 Close event triggered');
    console.log('   isUploading:', isUploading);
    console.log('   isReturningHome:', isReturningHome);
    console.log('   userQuitFromHome:', userQuitFromHome);
    
    // If the app is in the middle of uploading, don't show the box
    if (isUploading || isReturningHome || userQuitFromHome) {
      console.log('   Skipping close handler - already in closing state');
      return;
    }

    // If in study mode, show questionnaire
    console.log('   studyConditions.isEnabled():', studyConditions.isEnabled());
    if (studyConditions.isEnabled()) {
      e.preventDefault();
      console.log('📋 Study mode detected - showing end-of-session questionnaire');
      
      try {
        // Show questionnaire and wait for it to complete
        const result = await createQuestionnaireWindow();
        console.log('✅ Questionnaire completed, result:', result);
        
        // Now that questionnaire is done, proceed with app quit
        userQuitFromHome = true;
        app.quit();
      } catch (err) {
        console.error('❌ Error showing questionnaire:', err);
        userQuitFromHome = true;
        app.quit();
      }
      return;
    }

    // Normal mode: show confirmation dialog
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

function createQuestionnaireWindow() {
  return new Promise((resolve) => {
    console.log('📋 createQuestionnaireWindow() called');
    
    // If a questionnaire window already exists, destroy it first
    if (questionnaireWindow && !questionnaireWindow.isDestroyed()) {
      console.log('   Destroying existing questionnaire window');
      try {
        questionnaireWindow.destroy();
      } catch (err) {
        console.warn('   Error destroying existing window:', err);
      }
      questionnaireWindow = null;
    }

    console.log('   Creating new questionnaire window');
    // Use homeWindow if available, otherwise mainWindow
    const parentWindow = homeWindow || mainWindow;
    console.log('   Parent window:', parentWindow ? 'exists' : 'null');
    
    questionnaireWindow = new BrowserWindow({
      width: 1000,
      height: 900,
      modal: true,
      parent: parentWindow,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    console.log('   Loading end-session-questionnaire.html');
    questionnaireWindow.loadFile('end-session-questionnaire.html');

    questionnaireWindow.once('ready-to-show', () => {
      console.log('   Questionnaire window ready-to-show, displaying...');
      questionnaireWindow.show();
      console.log('   🎯 End-of-session questionnaire window is now visible');
    });

    // Prevent closing the questionnaire window via X button
    questionnaireWindow.on('close', (e) => {
      e.preventDefault();
      console.log('   User attempted to close questionnaire window - sending error message');
      // Send message to questionnaire renderer to show error
      if (questionnaireWindow && !questionnaireWindow.isDestroyed()) {
        questionnaireWindow.webContents.send('show-close-error');
      }
    });

    // Handle errors
    questionnaireWindow.webContents.on('crashed', () => {
      console.error('❌ Questionnaire window crashed');
      cleanup();
      resolve({ submitted: false, error: 'Window crashed' });
    });

    let questionnaireTimeout;
    let resolutionCalled = false;

    function cleanup() {
      console.log('   Cleaning up questionnaire window');
      if (questionnaireTimeout) {
        clearTimeout(questionnaireTimeout);
        questionnaireTimeout = null;
      }
      ipcMain.removeListener('questionnaire-responses-submitted', handleQuestionnaireSubmitted);
      ipcMain.removeListener('questionnaire-close-without-save', handleQuestionnaireClose);
      if (questionnaireWindow && !questionnaireWindow.isDestroyed()) {
        try {
          questionnaireWindow.destroy();
        } catch (err) {
          console.warn('   Error destroying questionnaire window:', err);
        }
        questionnaireWindow = null;
      }
    }

    const handleQuestionnaireSubmitted = (event, responses) => {
      console.log('✅ Questionnaire responses received');
      console.log('   Response data:', responses);
      
      // Remove listeners and close the window gracefully
      ipcMain.removeListener('questionnaire-responses-submitted', handleQuestionnaireSubmitted);
      ipcMain.removeListener('questionnaire-close-without-save', handleQuestionnaireClose);
      if (questionnaireTimeout) {
        clearTimeout(questionnaireTimeout);
        questionnaireTimeout = null;
      }
      
      if (questionnaireWindow && !questionnaireWindow.isDestroyed()) {
        console.log('   Closing questionnaire window (submitted)');
        questionnaireWindow.close();
      }
      
      // Resolve immediately - the 'closed' event will handle final cleanup
      if (!resolutionCalled) {
        resolutionCalled = true;
        resolve({ submitted: true, responses });
      }
    };

    const handleQuestionnaireClose = () => {
      console.log('⚠️ User closed questionnaire without submitting');
      
      // Remove listeners
      ipcMain.removeListener('questionnaire-responses-submitted', handleQuestionnaireSubmitted);
      ipcMain.removeListener('questionnaire-close-without-save', handleQuestionnaireClose);
      if (questionnaireTimeout) {
        clearTimeout(questionnaireTimeout);
        questionnaireTimeout = null;
      }
      
      if (!resolutionCalled) {
        resolutionCalled = true;
        resolve({ submitted: false });
      }
    };

    ipcMain.on('questionnaire-responses-submitted', handleQuestionnaireSubmitted);
    ipcMain.on('questionnaire-close-without-save', handleQuestionnaireClose);
    
    // Safety timeout: if questionnaire doesn't complete within 5 minutes, close it and quit anyway
    questionnaireTimeout = setTimeout(() => {
      console.warn('⏱️ Questionnaire timeout - closing questionnaire and quitting app');
      cleanup();
      if (!resolutionCalled) {
        resolutionCalled = true;
        resolve({ submitted: false, error: 'Timeout' });
      }
    }, 5 * 60 * 1000);
    
    questionnaireWindow.on('closed', () => {
      console.log('   Questionnaire window closed event');
      cleanup();
    });
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
  if (noteWindow && !noteWindow.isDestroyed()) return;
  if (noteWindow && noteWindow.isDestroyed()) {
    noteWindow = null;
  }

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

function createLightPromptWindow() {
  if (promptWindow) return;

  promptWindow = new BrowserWindow({
    width: 700,
    height: 500,
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

  promptWindow.loadFile('prompt-light.html');

  promptWindow.once('ready-to-show', () => {
    console.log('Light prompt window ready');
    promptWindow.show();
  });

  promptWindow.on('closed', () => {
    promptWindow = null;
  });
}

function createAIPromptWindow(gameTitle) {
  if (promptWindow) return;

  promptWindow = new BrowserWindow({
    width: 700,
    height: 600,
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

  promptWindow.loadFile('prompt-ai.html');

  promptWindow.once('ready-to-show', () => {
    console.log('AI prompt window ready');
    promptWindow.show();
    // Send game title to the prompt window
    promptWindow.webContents.send('session-data', { gameTitle });
  });

  promptWindow.on('closed', () => {
    promptWindow = null;
  });
}

function closePromptWindow() {
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.close();
    promptWindow = null;
  }
}

function createStartWindow() {
  if (startWindow) return;

  startWindow = new BrowserWindow({
    width: 400,
    height: 450,
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

  startWindow.webContents.on('did-finish-load', () => {
    // Send study mode info to start window
    if (studyConditions.isEnabled()) {
      startWindow.webContents.send('session-data', { studyMode: true });
    }
  });

}

function createRecentNotesWindow() {
  if (recentNotesWindow && !recentNotesWindow.isDestroyed()) return;
  if (recentNotesWindow && recentNotesWindow.isDestroyed()) {
    recentNotesWindow = null;
  }

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

function createModeSelectWindow() {
  return new Promise((resolve) => {
    if (modeSelectWindow) {
      modeSelectWindow.focus();
      return;
    }

    modeSelectWindow = new BrowserWindow({
      width: 600,
      height: 350,
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

    modeSelectWindow.loadFile('mode-select.html');

    modeSelectWindow.once('ready-to-show', () => {
      modeSelectWindow.show();
      console.log('Mode selection window ready');
    });

    const handleModeSelected = (event, mode) => {
      console.log(`User selected mode: ${mode}`);
      cleanup();
      resolve(mode);
    };

    function cleanup() {
      ipcMain.removeListener('mode-selected', handleModeSelected);
      if (modeSelectWindow) {
        modeSelectWindow.close();
        modeSelectWindow = null;
      }
    }

    ipcMain.on('mode-selected', handleModeSelected);
    modeSelectWindow.on('closed', () => cleanup());
  });
}

function createConditionSelectWindow() {
  return new Promise((resolve) => {
    if (conditionSelectWindow) {
      conditionSelectWindow.focus();
      return;
    }

    conditionSelectWindow = new BrowserWindow({
      width: 750,
      height: 450,
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

    conditionSelectWindow.loadFile('condition-select.html');

    conditionSelectWindow.once('ready-to-show', () => {
      conditionSelectWindow.show();
      console.log('Condition selection window ready');
    });

    const handleConditionSelected = (event, condition) => {
      console.log(`User selected condition: ${condition}`);
      cleanup();
      resolve(condition);
    };

    const handleConditionSelectClose = () => {
      console.log('User clicked back button');
      cleanup();
      resolve('back');
    };

    function cleanup() {
      ipcMain.removeListener('condition-selected', handleConditionSelected);
      ipcMain.removeListener('condition-select-close', handleConditionSelectClose);
      if (conditionSelectWindow) {
        conditionSelectWindow.close();
        conditionSelectWindow = null;
      }
    }

    ipcMain.on('condition-selected', handleConditionSelected);
    ipcMain.on('condition-select-close', handleConditionSelectClose);
    conditionSelectWindow.on('closed', () => cleanup());
  });
}

function createStudyLoginWindow() {
  return new Promise((resolve) => {
    if (studyLoginWindow) {
      studyLoginWindow.focus();
      return;
    }

    studyLoginWindow = new BrowserWindow({
      width: 500,
      height: 600,
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

    studyLoginWindow.loadFile('study-login.html');

    studyLoginWindow.once('ready-to-show', () => {
      studyLoginWindow.show();
      console.log('Study login window ready');
    });

    const handleStudyLoginSuccess = (event, loginData) => {
      console.log(`Study login successful for cohort: ${loginData.cohortId}, week: ${loginData.weekNumber}`);
      studyLoginInfo = loginData;
      cleanup();
      resolve(loginData);
    };

    const handleStudyLoginBack = () => {
      console.log('User clicked back from study login');
      cleanup();
      resolve('back');
    };

    function cleanup() {
      ipcMain.removeListener('study-login-success', handleStudyLoginSuccess);
      ipcMain.removeListener('study-login-back', handleStudyLoginBack);
      if (studyLoginWindow) {
        studyLoginWindow.close();
        studyLoginWindow = null;
      }
    }

    ipcMain.on('study-login-success', handleStudyLoginSuccess);
    ipcMain.on('study-login-back', handleStudyLoginBack);
    studyLoginWindow.on('closed', () => cleanup());
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

    // Handle window close event (X button or close app)
    homeWindow.on('close', async (e) => {
      console.log('🔴 Home window close event triggered');
      console.log('   studyConditions.isEnabled():', studyConditions.isEnabled());
      console.log('   isNavigatingFromHome:', isNavigatingFromHome);
      
      // Skip questionnaire if we're just navigating away (not actually quitting)
      if (isNavigatingFromHome) {
        isNavigatingFromHome = false;
        return;
      }
      
      // If in study mode, show questionnaire before closing
      if (studyConditions.isEnabled()) {
        e.preventDefault();
        console.log('📋 Study mode detected - showing end-of-session questionnaire');
        
        // Hide the home window so questionnaire is visible
        if (homeWindow && !homeWindow.isDestroyed()) {
          console.log('   Hiding home window');
          homeWindow.hide();
        }
        
        try {
          // Show questionnaire and wait for it to complete
          const result = await createQuestionnaireWindow();
          console.log('✅ Questionnaire completed, result:', result);
          
          // Now that questionnaire is done, proceed with app quit
          userQuitFromHome = true;
          app.quit();
        } catch (err) {
          console.error('❌ Error showing questionnaire:', err);
          userQuitFromHome = true;
          app.quit();
        }
        return;
      }
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
      isNavigatingFromHome = true;  // Prevent questionnaire from showing
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
    if (!noteWindow || noteWindow.isDestroyed()) {
      noteWindow = null;
      createNoteWindow();
    }
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
      const studyCondition = studyConditions.isEnabled() ? studyConditions.getCondition() : null;
      mainWindow.webContents.send('session-data', {
        username: sessionMetadata.getUsername(),
        studyCondition,
        studyMode: studyConditions.isEnabled()
      });
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
      // Check if we should show review based on study condition or app config
      const shouldShowReview = studyConditions.isEnabled() 
        ? studyConditions.shouldShowReview() 
        : (appConfig.reviewMode === 'ai' || appConfig.reviewMode === 'text');

      // Always show loading window and stop FFmpeg first
      if (!shouldShowReview || appConfig.reviewMode !== 'ai') {
        createLoadingWindow();
      }
      await stopFFMpegRecording();
      
      // Then handle review based on mode
      if (shouldShowReview) {
        closeLoadingWindow();
        const reviewText = await createPostGameReviewWindow();
        sessionMetadata.setPostGameReview(reviewText);
        
        // Save the condition this review was generated under
        if (studyConditions.isEnabled()) {
          sessionMetadata.setPostGameReviewCondition(studyConditions.getCondition());
        }
        
        // Save metadata to local storage and S3
        console.log('💾 Saving post-game review to metadata...');
        await saveMetadataLocally();
        if (awsManager && studyConditions.isEnabled()) {
          try {
            await awsManager.saveMetadata(sessionMetadata);
            console.log('✅ Review saved to S3');
          } catch (err) {
            console.warn('⚠️ Failed to save review to S3:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('Error during FFMPEG shutdown:', err);
    } finally {
      closeLoadingWindow();
    }
    if (noteWindow) {
      const existingNoteWindow = noteWindow;
      noteWindow = null;
      if (!existingNoteWindow.isDestroyed()) {
        existingNoteWindow.close();
      }
    }
    if (recentNotesWindow) {
      const existingRecentNotesWindow = recentNotesWindow;
      recentNotesWindow = null;
      if (!existingRecentNotesWindow.isDestroyed()) {
        existingRecentNotesWindow.close();
      }
    }
    closeAllIndexWindows();
    createMainWindow();
    isUploading = false;
  });
}

async function startRecordingPhase() {
  /**
   * Starts FFmpeg recording and creates annotation/overlay windows
   * Called after game title is entered and prompt (if any) is confirmed
   */
  isRecordingSetup = true;
  console.log('🎙️ Starting recording phase setup...');
  
  try {
    await startFFMpegRecording();
    console.log('✅ FFMPEG recording started');
    
    createNoteWindow();        // open overlay window
    createEmojiWindow();
    
    // Send study condition to overlay if available
    const studyCondition = studyConditions.isEnabled() ? studyConditions.getCondition() : null;
    console.log('📋 Study condition from studyConditions:', studyCondition);
    if (noteWindow && !noteWindow.isDestroyed()) {
      setTimeout(() => {
        console.log('� Sending study condition to overlay:', studyCondition || 'none');
        noteWindow.webContents.send('set-study-condition', studyCondition);
      }, 500); // Increased delay to ensure overlay is fully ready
    } else {
      console.warn('⚠️ Note window not available to send study condition');
    }
    
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
    
    console.log('✅ Recording phase setup complete');
    
    // Allow brief time for windows to fully initialize before clearing the flag
    setTimeout(() => {
      isRecordingSetup = false;
      console.log('✅ Recording phase setup flag cleared');
    }, 500);
    
  } catch (err) {
    console.error('Error starting recording phase:', err);
    isRecordingSetup = false;
    dialog.showMessageBoxSync({
      type: 'error',
      buttons: ['OK'],
      title: 'Recording Error',
      message: 'Failed to start recording'
    });
  }
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
  sessionMetadata.setPostGameReview('');

  registerShortcuts();
  createStartWindow();
  
  // FFmpeg recording and other windows will be created after prompt confirmation or immediately if no prompt
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

async function showStartupFlow() {
  // Show mode selection window
  const selectedMode = await createModeSelectWindow();
  
  if (selectedMode === 'study') {
    // Show study login (which will determine condition based on participant ID)
    const loginResult = await createStudyLoginWindow();
    
    if (loginResult === 'back') {
      // User clicked back from login - restart the flow
      return showStartupFlow();
    }

    // Map condition letter from S3: A=control, B=light, C=ai
    const conditionMap = {
      'A': 'control',
      'B': 'light',
      'C': 'ai'
    };
    
    const descriptiveCondition = conditionMap[loginResult.condition];
    
    // Map to StudyConditions internal format
    const studyConditionMap = {
      'control': 'control',
      'light': 'prompt-light',
      'ai': 'prompt-ai'
    };
    
    const selectedCondition = studyConditionMap[descriptiveCondition];

    // Initialize study conditions with automatically-determined condition
    try {
      await studyConditions.initialize(sessionMetadata.getUsername(), awsManager, selectedCondition);
      console.log(`📋 Study mode enabled for user ${sessionMetadata.getUsername()}`);
      console.log(`   Session ${studyConditions.getSessionNumber() + 1}/6`);
      console.log(`   Participant: ${loginResult.participantId}`);
      console.log(`   Cohort: ${loginResult.cohortId}, Week: ${loginResult.weekNumber}`);
      console.log(`   Condition: ${loginResult.condition} (${descriptiveCondition}) -> ${selectedCondition}`);
    } catch (err) {
      console.warn(`⚠️ Could not initialize study conditions:`, err.message);
    }
  } else {
    // User selected normal mode
    console.log('📋 Normal mode selected');
    studyConditions.enabled = false;
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
  
  // Initialize AWS manager with error handling
  try {
    await awsManager.init();
    console.log('✅ AWS S3 client initialized');
  } catch (err) {
    console.error('❌ Failed to initialize AWS S3 client:', err.message);
    console.log('⚠️ S3 operations will be unavailable. Local storage will be used.');
  }

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

  // Show startup flow (mode/condition selection)
  await showStartupFlow();

  // Now show home window
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
  ipcMain.on('save-session-chat-transcript', (event, { gameTitle, username, fileTimestamp, transcript }) => {
    try {
      saveChatTranscript(username, fileTimestamp, transcript, gameTitle).catch((err) => {
        console.error('Error saving chat transcript:', err);
      });
    } catch (err) {
      console.error('Error saving chat transcript:', err);
    }
  });
  ipcMain.on('save-start', (event, { title, mood, mind }) => {
    sessionMetadata.setTitle(title);
    
    // Store study metadata if provided
    if (mood || mind) {
      // Store in a custom field on metadata for later retrieval
      sessionMetadata.studyMetadata = {
        mood: mood || '',
        mind: mind || ''
      };
      console.log('📋 Study session info captured:');
      console.log(`   Mood: ${mood || '(not provided)'}`);
      console.log(`   Mind: ${mind || '(not provided)'}`);
    }
    
    maybeWriteSessionMetadata();

    // Check if we need to show a prompt based on study condition
    if (studyConditions.isEnabled()) {
      if (studyConditions.shouldShowLightPrompt()) {
        createLightPromptWindow();
      } else if (studyConditions.shouldShowAIPrompt()) {
        createAIPromptWindow(title);
      } else {
        // Control condition - no prompt, start recording immediately
        console.log('📋 Study mode: Control condition - starting recording immediately');
        startRecordingPhase();
      }
    } else {
      // Normal mode - start recording immediately
      startRecordingPhase();
    }
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

  ipcMain.on('show-idle-reminder-request', () => {
    console.log('📬 Received idle reminder request from overlay');
    // Show or create recent notes window if not visible
    if (!recentNotesWindow || recentNotesWindow.isDestroyed()) {
      console.log('📬 Recent notes window not found, creating...');
      createRecentNotesWindow();
    }
    if (recentNotesWindow && !recentNotesWindow.isVisible()) {
      console.log('📬 Showing recent notes window');
      recentNotesWindow.show();
    }
    // Send reminder to recent notes window after a brief delay to ensure it's ready
    setTimeout(() => {
      if (recentNotesWindow && !recentNotesWindow.isDestroyed()) {
        console.log('📬 Sending show-idle-reminder to recent-notes window');
        recentNotesWindow.webContents.send('show-idle-reminder');
        console.log('📬 Idle reminder sent successfully');
      } else {
        console.warn('⚠️ Recent notes window not available');
      }
    }, 100);
  });

  ipcMain.on('request-study-info', (event) => {
    // Send study mode info to requesting window
    if (studyConditions.isEnabled()) {
      event.reply('session-data', { studyMode: true });
    }
  });

  ipcMain.on('verify-study-credentials', async (event, { participantId, cohortId, weekNumber, password }) => {
    try {
      // Load combined_passwords.json from S3
      const passwordData = await awsManager.readStudyPasswordsFile();

      // Verify cohort exists
      if (!passwordData[cohortId]) {
        event.reply('study-credentials-verified', {
          success: false,
          error: `Cohort "${cohortId}" not found`
        });
        return;
      }

      // Get the password list for the cohort
      const cohortPasswords = passwordData[cohortId];

      // Verify week number is valid
      if (weekNumber < 1 || weekNumber > cohortPasswords.length) {
        event.reply('study-credentials-verified', {
          success: false,
          error: `Week ${weekNumber} is not valid for cohort "${cohortId}". Valid weeks: 1-${cohortPasswords.length}`
        });
        return;
      }

      // Verify password (case-sensitive)
      const correctPassword = cohortPasswords[weekNumber - 1];
      console.log(`🔐 Password verification for ${cohortId}, week ${weekNumber}:`);
      console.log(`   Expected: "${correctPassword}"`);
      console.log(`   Actual:   "${password}"`);
      console.log(`   Match: ${password === correctPassword}`);
      if (password !== correctPassword) {
        event.reply('study-credentials-verified', {
          success: false,
          error: 'Incorrect password'
        });
        return;
      }

      // Load conditions.json to determine participant's condition
      const conditionsData = await awsManager.readConditionsFile();
      
      if (!conditionsData[participantId]) {
        event.reply('study-credentials-verified', {
          success: false,
          error: `Participant "${participantId}" not found in conditions`
        });
        return;
      }

      const participantConditions = conditionsData[participantId];
      
      if (weekNumber < 1 || weekNumber > participantConditions.length) {
        event.reply('study-credentials-verified', {
          success: false,
          error: `Week ${weekNumber} is not valid for ${participantId}. Valid weeks: 1-${participantConditions.length}`
        });
        return;
      }

      const assignedCondition = participantConditions[weekNumber - 1];
      
      // Map condition letter from S3: A=control, B=light, C=ai
      const conditionMap = {
        'A': 'control',
        'B': 'light',
        'C': 'ai'
      };
      
      console.log(`🎯 Study credentials verified for ${participantId}, week ${weekNumber}`);
      console.log(`   Assigned condition: ${assignedCondition} (${conditionMap[assignedCondition] || 'unknown'})`);
      
      event.reply('study-credentials-verified', {
        success: true,
        condition: assignedCondition
      });
    } catch (err) {
      console.error('Error verifying study credentials:', err);
      event.reply('study-credentials-verified', {
        success: false,
        error: 'Error verifying credentials. Please try again.'
      });
    }
  });

  ipcMain.on('light-prompt-confirmed', () => {
    console.log('👤 User confirmed light prompt');
    closePromptWindow();
    startRecordingPhase();
  });

  ipcMain.on('ai-prompt-confirmed', () => {
    console.log('🤖 User confirmed AI prompt');
    closePromptWindow();
    startRecordingPhase();
  });

  ipcMain.on('hide-prompt', () => {
    closePromptWindow();
  });

  ipcMain.on('generate-ai-suggestions', async (event, { gameTitle }) => {
    if (!geminiService) {
      event.reply('ai-suggestions-ready', {
        error: 'AI service not available',
        suggestions: null
      });
      return;
    }

    try {
      // Generate suggestions based on game title
      // This uses a simple prompt to Gemini to suggest annotation topics
      const suggestions = await geminiService.generateAnnotationSuggestions(gameTitle);
      event.reply('ai-suggestions-ready', { suggestions });
    } catch (err) {
      console.error('Error generating AI suggestions:', err);
      event.reply('ai-suggestions-ready', {
        error: err.message,
        suggestions: null
      });
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

console.log('🔧 Registering open-session-chat listener...');
  ipcMain.on('open-session-chat', async (event, { gameTitle, username, fileTimestamp }) => {
    console.log('✅ open-session-chat received:', { gameTitle, username, fileTimestamp });
    try {
      await createSessionChatWindow(gameTitle, username, fileTimestamp);
      console.log('✅ Chat window opened successfully');
    } catch (err) {
      console.error('❌ Error opening chat window:', err);
    }
  });
console.log('✅ open-session-chat listener registration complete');

  ipcMain.on('hide-username', () => {
    if (usernamePromptWindow && usernamePromptWindow.isVisible()) {
      usernamePromptWindow.close();
    }
  });

  // Save study session results to S3
  async function saveStudyResultsToS3(responses) {
    if (!studyLoginInfo || !awsManager) {
      console.warn('⚠️ Cannot save results - missing study info or AWS manager');
      return;
    }

    try {
      console.log('💾 Saving study results to S3...');

      // Get all required data
      const username = sessionMetadata.getUsername();
      const participantId = studyLoginInfo.participantId;
      const cohortId = studyLoginInfo.cohortId;
      const weekNumber = studyLoginInfo.weekNumber;
      const condition = studyLoginInfo.condition;
      const preGameMood = sessionMetadata.studyMetadata?.mood || '';
      const preGameMind = sessionMetadata.studyMetadata?.mind || '';
      const postGameReview = sessionMetadata.getPostGameReview() || '';
      const gameTitle = sessionMetadata.getTitle() || '';
      const timestamp = new Date().toISOString();

      // Map condition letter from S3: A=control, B=light, C=ai
      const conditionMap = {
        'A': 'control',
        'B': 'light',
        'C': 'ai'
      };
      const conditionName = conditionMap[condition] || condition;

      // Format the file content
      let fileContent = '';
      fileContent += `STUDY SESSION RESULTS\n`;
      fileContent += `${'='.repeat(50)}\n\n`;

      fileContent += `PARTICIPANT INFORMATION\n`;
      fileContent += `${'-'.repeat(50)}\n`;
      fileContent += `Username: ${username}\n`;
      fileContent += `Participant ID: ${participantId}\n`;
      fileContent += `Cohort ID: ${cohortId}\n`;
      fileContent += `Week Number: ${weekNumber}\n`;
      fileContent += `Condition: ${condition} (${conditionName})\n`;
      fileContent += `Timestamp: ${timestamp}\n\n`;

      fileContent += `GAME SESSION\n`;
      fileContent += `${'-'.repeat(50)}\n`;
      fileContent += `Game Title: ${gameTitle}\n\n`;

      fileContent += `PRE-GAME REFLECTION\n`;
      fileContent += `${'-'.repeat(50)}\n`;
      fileContent += `Emotion/Mood: ${preGameMood}\n`;
      fileContent += `Thought/Mind: ${preGameMind}\n\n`;

      fileContent += `POST-GAME REFLECTION\n`;
      fileContent += `${'-'.repeat(50)}\n`;
      fileContent += `${postGameReview || '(No response provided)'}\n\n`;

      fileContent += `QUESTIONNAIRE RESPONSES\n`;
      fileContent += `${'-'.repeat(50)}\n`;

      // Format questionnaire responses
      if (responses.reflection) {
        fileContent += `\nREFLECTION (1-5 scale)\n`;
        fileContent += `  Q1 - I will apply principles learned from this game in my daily life: ${responses.reflection.ref1 || 'N/A'}\n`;
        fileContent += `  Q2 - The game's content was helpful for my development: ${responses.reflection.ref2 || 'N/A'}\n`;
        fileContent += `  Q3 - I feel confident about what I learned: ${responses.reflection.ref3 || 'N/A'}\n`;
      }

      if (responses.rumination) {
        fileContent += `\nRUMINATION (1-5 scale)\n`;
        fileContent += `  Q4 - I keep thinking about challenges I faced in the game: ${responses.rumination.rum1 || 'N/A'}\n`;
        fileContent += `  Q5 - I worry about my performance in the game: ${responses.rumination.rum2 || 'N/A'}\n`;
        fileContent += `  Q6 - I repeatedly think about things that went wrong: ${responses.rumination.rum3 || 'N/A'}\n`;
      }

      if (responses.selfFocusedThinking) {
        fileContent += `\nSELF-FOCUSED THINKING (1-5 scale)\n`;
        fileContent += `  Q7 - I was focused on myself rather than the game: ${responses.selfFocusedThinking.thk1 || 'N/A'}\n`;
        fileContent += `  Q8 - I was concerned about how others viewed my performance: ${responses.selfFocusedThinking.thk2 || 'N/A'}\n`;
        fileContent += `  Q9 - I was aware of myself and my surroundings: ${responses.selfFocusedThinking.thk3 || 'N/A'}\n`;
      }

      if (responses.gameExperience) {
        fileContent += `\nGAME EXPERIENCE (1-5 scale)\n`;
        fileContent += `  Q10 - I enjoyed playing this game: ${responses.gameExperience.gex1 || 'N/A'}\n`;
        fileContent += `  Q11 - The game was challenging: ${responses.gameExperience.gex2 || 'N/A'}\n`;
        fileContent += `  Q12 - I felt engaged during the game: ${responses.gameExperience.gex3 || 'N/A'}\n`;
        fileContent += `  Q13 - The game was fun: ${responses.gameExperience.gex4 || 'N/A'}\n`;
        fileContent += `  Q14 - I was focused on the game: ${responses.gameExperience.gex5 || 'N/A'}\n`;
        fileContent += `  Q15 - The game was interesting: ${responses.gameExperience.gex6 || 'N/A'}\n`;
        fileContent += `  Q16 - I would play this game again: ${responses.gameExperience.gex7 || 'N/A'}\n`;
        fileContent += `  Q17 - The game was easy to understand: ${responses.gameExperience.gex8 || 'N/A'}\n`;
        fileContent += `  Q18 - I felt motivated to do well: ${responses.gameExperience.gex9 || 'N/A'}\n`;
        fileContent += `  Q19 - The game helped me learn something new: ${responses.gameExperience.gex10 || 'N/A'}\n`;
        fileContent += `  Q20 - I felt in control during the game: ${responses.gameExperience.gex11 || 'N/A'}\n`;
      }

      fileContent += `\n${'='.repeat(50)}\nEnd of Report\n`;

      // Create buffer from file content
      const buffer = Buffer.from(fileContent, 'utf-8');

      // Create filename: [username]_[participant_id]_[week_number].txt
      const filename = `${username}_${participantId}_${weekNumber}.txt`;
      const s3Key = `study-results/${filename}`;

      // Upload to S3
      if (awsManager && awsManager.s3) {
        await awsManager.s3.putObject({
          Bucket: awsManager.bucket,
          Key: s3Key,
          Body: buffer,
          ContentType: 'text/plain'
        }).promise();

        console.log(`✅ Study results saved to S3: s3://${awsManager.bucket}/${s3Key}`);
        return true;
      } else {
        console.warn('⚠️ S3 client not available');
        return false;
      }

    } catch (err) {
      console.error('❌ Error saving study results to S3:', err);
      return false;
    }
  }

  // Handle questionnaire submission - destroy all windows and quit the app
  ipcMain.on('questionnaire-responses-submitted-final', async (event, responses) => {
    console.log('✅✅✅ Questionnaire submitted - HANDLER CALLED');
    console.log('   Responses:', responses);

    // Save results to S3
    try {
      await saveStudyResultsToS3(responses);
    } catch (err) {
      console.error('⚠️ Error in save function:', err);
    }
    
    // Destroy all windows immediately
    try {
      if (questionnaireWindow && !questionnaireWindow.isDestroyed()) {
        console.log('   Destroying questionnaire window');
        questionnaireWindow.destroy();
      }
    } catch (e) { console.warn('Error destroying questionnaire:', e); }
    
    try {
      if (homeWindow && !homeWindow.isDestroyed()) {
        console.log('   Destroying home window');
        homeWindow.destroy();
      }
    } catch (e) { console.warn('Error destroying home:', e); }
    
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('   Destroying main window');
        mainWindow.destroy();
      }
    } catch (e) { console.warn('Error destroying main:', e); }
    
    console.log('   FORCE QUITTING - process.exit()');
    // Force exit the entire process
    process.exit(0);
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
  ipcMain.handle('get-session-chat-transcript', async (event, { username, fileTimestamp }) => {
    return loadChatTranscript(username, fileTimestamp);
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
  ipcMain.handle('update-local-session-review', async (event, { username, fileTimestamp, review }) => {
    await updateLocalSessionReview(username, fileTimestamp, review);
    return { success: true };
  });
  ipcMain.handle('update-s3-session-review', async (event, { username, fileTimestamp, review }) => {
    if (!awsManager) {
      throw new Error('AWS Manager not initialized');
    }
    if (!username || !fileTimestamp) {
      throw new Error('Username and fileTimestamp are required to update S3 session review.');
    }
    await awsManager.updateSessionReview(username, fileTimestamp, review || '');
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
    
    // If we are currently setting up recording (transitioning between windows)
    if (isRecordingSetup) {
      console.log("Setting up recording, skipping quit.");
      return;
    }
    
    console.log("All windows closed, quitting app");

    // or if we are on macOS, don't quit the app.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
