const { define, DataType, open, createPointer } = require('ffi-rs');


open({
    library: "User32",
    path: "User32.dll",
});

const user32 = define({
    GetForegroundWindow: {
        library: "User32",
        retType: DataType.External, // HWND is a pointer-sized integer (64-bit on 64-bit Windows)
        paramsType: [],
    },
    SetForegroundWindow: {
        library: "User32",
        retType: DataType.Boolean,
        paramsType: [DataType.External],
    },
    SetFocus: {
        library: "User32",
        retType: DataType.External,
        paramsType: [DataType.External],
    },
    SetActiveWindow: {
        library: "User32",
        retType: DataType.External,
        paramsType: [DataType.External],
    }
})

/**
 * Gets the handle of the currently focused window
 * @returns {number} The window handle (HWND)
 */
function getFocusedWindow() {
    return user32.GetForegroundWindow([])
}

/**
 * Sets focus to a window based on its handle
 * @param {number} hwnd - The window handle (HWND) to focus
 */
function setFocusedWindow(hwnd) {
    if (!hwnd || hwnd === 0) {
        return;
    }
    // Here is an answer I found on StackOverflow which is completely wrong and
    // crashes instantly: https://stackoverflow.com/a/39604463
    user32.SetForegroundWindow([hwnd]);
    user32.SetFocus([hwnd]);
    user32.SetActiveWindow([hwnd]);
}

module.exports = {
    getFocusedWindow: getFocusedWindow,
    setFocusedWindow: setFocusedWindow
};
