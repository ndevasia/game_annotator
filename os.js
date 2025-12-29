const os = require('os');
const platform = os.platform();

var osModule;

// Load the appropriate OS-specific module
if (platform === 'win32') {
    osModule = require('./os/windows.js');
} else if (platform === 'darwin') {
    try {
        osModule = require('./os/macos.js');
    } catch (error) {
        throw new Error('macOS support not yet implemented. Please create os/macos.js with getFocusedWindow and setFocusedWindow functions.');
    }
} else {
    throw new Error('Unsupported platform: ' + platform);
}

/**
 * Gets the handle of the currently focused window
 * @returns {number} The window handle
 */
function getFocusedWindow() {
    return osModule.getFocusedWindow();
}

/**
 * Sets focus to a window based on its handle
 * @param {number} handle - The window handle to focus
 */
function setFocusedWindow(handle) {
    return osModule.setFocusedWindow(handle);
}

module.exports = {
    getFocusedWindow: getFocusedWindow,
    setFocusedWindow: setFocusedWindow
};
