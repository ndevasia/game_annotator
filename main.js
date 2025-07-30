const { app, BrowserWindow, globalShortcut } = require('electron');

const fs = require('fs');
const { ipcMain } = require('electron');

const annotationsFilePath = 'annotations.json';

const OBSWebSocket = require('obs-websocket-js');
const obs = new OBSWebSocket.OBSWebSocket();

// const OBS_ADDRESS = 'ws://localhost:4455'; // Change if different port or remote host
// const OBS_PASSWORD = ''; // Put your password here if you set onenpm

// For OBS, I needed to disable authentication as well as set a particular source for the display. 
// I also manually set the output source to this folder/Videos.


// Ensure the file exists
if (!fs.existsSync(annotationsFilePath)) {
  fs.writeFileSync(annotationsFilePath, JSON.stringify([]));
}

let noteWindow = null;

// Function to create the note overlay window
function createNoteWindow() {
  if (noteWindow) {
    return;
  }
  
  noteWindow = new BrowserWindow({
    width: 400,
    height: 200,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,  // <-- Add this line
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false // For simplicity in this prototype
    }
  });
  
  noteWindow.loadFile('overlay.html');
  noteWindow.once('ready-to-show', () => {
    console.log('Overlay window ready');
  });

  noteWindow.on('blur', () => noteWindow.hide());

  noteWindow.on('closed', () => {
    noteWindow = null;
  });
}

// Optionally create a hidden main window if needed
// function createMainWindow() {
//   let mainWin = new BrowserWindow({
//     show: false, // Main window is hidden as the overlay will be used for annotations
//     webPreferences: {
//       nodeIntegration: true,
//       contextIsolation: false,
//     }
//   });
// }

async function connectOBS() {
  try {
    await obs.connect();

    console.log('Connected to OBS WebSocket');

    const { outputActive } = await obs.call('GetRecordStatus');
    if (!outputActive) {
      await obs.call('StartRecord');
      console.log('OBS recording started');
    }
  } catch (error) {
    console.error('Failed to connect or start recording:', error);
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


app.whenReady().then(() => {
    createNoteWindow();
    connectOBS();
  // Register global hotkey (Ctrl/Cmd + Shift + N)
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (noteWindow) {
      if (!noteWindow.isVisible()) noteWindow.show();
      noteWindow.focus();
    }
  });
  // New quit hotkey
  globalShortcut.register('CommandOrControl+Shift+Q', async () => {
    console.log('Quit hotkey pressed: stopping recording and quitting app');
    await stopOBSRecording(); // Make sure to stop recording cleanly
    app.quit();
  });

  console.log('Registered shortcuts:', globalShortcut.isRegistered('CommandOrControl+Shift+N'), globalShortcut.isRegistered('CommandOrControl+Shift+Q'));


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

  app.on('activate', () => {
    // On macOS, re-create a window in the app when the dock icon is clicked and there are no other windows open.
    // if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

let isQuitting = false;

app.on('before-quit', async (event) => {
  if (!isQuitting) {
    event.preventDefault(); // Only prevent the first time

    console.log('Gracefully stopping OBS before quitting...');
    await stopOBSRecording();
    obs.disconnect();

    isQuitting = true;
    app.quit(); // Trigger quit again — this time will go through
  }
});



// Unregister all shortcuts when quitting.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // On macOS it's common for apps to stay open until the user quits explicitly with Cmd + Q.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
