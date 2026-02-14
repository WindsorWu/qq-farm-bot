/**
 * Console logger with daily file rotation.
 * Writes logs to logs/YYYY-MM-DD.log while keeping terminal output.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = path.join(process.cwd(), 'logs');

let initialized = false;
let currentDateKey = '';
let stream = null;
let disabled = false;

function pad2(n) {
    return String(n).padStart(2, '0');
}

function getDateKey(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getDateTime(d) {
    return `${getDateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function ensureStream() {
    if (disabled) return;

    const now = new Date();
    const dateKey = getDateKey(now);
    if (stream && dateKey === currentDateKey) return;

    if (stream) {
        stream.end();
        stream = null;
    }

    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const file = path.join(LOG_DIR, `${dateKey}.log`);
        stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
        currentDateKey = dateKey;
    } catch (err) {
        disabled = true;
        process.stderr.write(`[logger] 初始化日志文件失败: ${err.message}\n`);
    }
}

function appendLine(level, args) {
    ensureStream();
    if (!stream || disabled) return;

    const now = new Date();
    const message = util.formatWithOptions({ colors: false, depth: null }, ...args);
    const line = `[${getDateTime(now)}] [${level}] ${message}\n`;
    stream.write(line);
}

function initFileLogger() {
    if (initialized) return;
    initialized = true;

    const rawLog = console.log.bind(console);
    const rawWarn = console.warn.bind(console);
    const rawError = console.error.bind(console);

    console.log = (...args) => {
        rawLog(...args);
        appendLine('INFO', args);
    };

    console.warn = (...args) => {
        rawWarn(...args);
        appendLine('WARN', args);
    };

    console.error = (...args) => {
        rawError(...args);
        appendLine('ERROR', args);
    };

    process.on('exit', () => {
        if (stream) {
            stream.end();
            stream = null;
        }
    });
}

module.exports = {
    initFileLogger,
};
