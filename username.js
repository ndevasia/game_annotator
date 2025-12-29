const { readConfig, writeConfig } = require('./config.js');
const AWSManager = require('./backend/aws.js');

async function readUsername() {
    return (await readConfig()).username;
}

async function writeUsername(username) {
    await writeConfig({ username });
}

async function submitUsername(username) {
    const awsManager = new AWSManager(username);
    await awsManager.init();
    awsManager.createFileStructure(username);
    await writeUsername(username);
    return awsManager;
}

module.exports = {
    readUsername,
    writeUsername,
    submitUsername
};
