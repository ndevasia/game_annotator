const { spawn } = require("child_process");
const { app } = require("electron");

let children = [];

/**
 * Spawn and track a child process
 * Works just like child_process.spawn
 */
function spawnTracked(command, args = [], options = {}) {
  const child = spawn(command, args, options);

  children.push(child);

  // Remove from list when it exits
  child.on("exit", () => {
    children = children.filter(c => c !== child);
  });

  return child;
}

/**
 * Kill all tracked child processes
 */
function killAllChildren() {
  for (const child of children) {
    try {
      if (process.platform === "win32") {
        // Windows requires taskkill to kill the whole process tree
        spawn("taskkill", ["/PID", child.pid, "/F", "/T"]);
      } else {
        child.kill("SIGTERM");
      }
    } catch (err) {
      console.error("Error killing child:", err);
    }
  }
  children = [];
}

// Ensure cleanup on quit
app.on("before-quit", () => {
  console.log("Cleaning up child processes...");
  killAllChildren();
});

module.exports = {
  spawnTracked,
  killAllChildren,
};