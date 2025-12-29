const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function getConfigPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

async function readConfig() {
    const configPath = getConfigPath();
    try {
        return JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    } catch {
        return {};
    }
}

async function writeConfig(config) {
    const configPath = getConfigPath();
    const oldConfig = await readConfig();
    config = { ...oldConfig, ...config };
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
}

module.exports = {
    getConfigPath,
    readConfig,
    writeConfig
};
