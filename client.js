/**
 * QQ经典农场 挂机脚本 - 入口文件
 *
 * 模块结构:
 *   src/config.js   - 配置常量与枚举
 *   src/utils.js    - 通用工具函数
 *   src/proto.js    - Protobuf 加载与类型管理
 *   src/network.js  - WebSocket 连接/消息编解码/登录/心跳
 *   src/farm.js     - 自己农场操作与巡田循环
 *   src/friend.js   - 好友农场操作与巡查循环
 *   src/decode.js   - PB解码/验证工具模式
 */

// 从环境变量注入命令行参数（用于 Heroku 等不做 shell 展开的运行环境）
// 放在 client.js 的最顶部，尽早运行，确保后续代码能从 process.argv 读取到 --code 和其它参数
// 现在 LOGIN_CODE 和 HEROKU_EXTRA_ARGS 都是可选的：如果两者都不存在则不做任何修改
if (!process.argv.includes('--code')) {
  const envCode = process.env.LOGIN_CODE;
  const rawExtra = process.env.HEROKU_EXTRA_ARGS ? process.env.HEROKU_EXTRA_ARGS.trim().split(/\s+/).filter(Boolean) : [];

  // 清理 extra：移除任何显式的 --code 或 --code=xxx，以免重复或冲突
  const sanitizedExtra = [];
  for (let i = 0; i < rawExtra.length; i++) {
    const tok = rawExtra[i];
    if (tok === '--code') {
      // 跳过下一个 token（被当作 --code 的值）
      i++;
      continue;
    }
    if (tok.startsWith('--code=')) {
      continue;
    }
    sanitizedExtra.push(tok);
  }

  // 去重：不要添加已经存在于 process.argv 的参数
  const toAdd = sanitizedExtra.filter(t => !process.argv.includes(t));

  // 只有在有要注入的内容时才修改 process.argv
  if (envCode || toAdd.length) {
    const base = [process.argv[0], process.argv[1]];
    if (envCode) {
      base.push('--code', envCode);
    }
    process.argv = [...base, ...toAdd, ...process.argv.slice(2)];
  }
}

const { CONFIG } = require('./src/config');
const { loadProto } = require('./src/proto');
const { connect, cleanup, getWs, networkEvents } = require('./src/network');
const { startFarmCheckLoop, stopFarmCheckLoop } = require('./src/farm');
const { startFriendCheckLoop, stopFriendCheckLoop } = require('./src/friend');
const { initTaskSystem, cleanupTaskSystem } = require('./src/task');
const { initStatusBar, cleanupStatusBar, setStatusPlatform } = require('./src/status');
const { startSellLoop, stopSellLoop, debugSellFruits } = require('./src/warehouse');
const { processInviteCodes } = require('./src/invite');
const { verifyMode, decodeMode } = require('./src/decode');
const { emitRuntimeHint, sleep } = require('./src/utils');
const { getQQFarmCodeByScan } = require('./src/qqQrLogin');
const { initFileLogger } = require('./src/logger');

initFileLogger();

// ============ 帮助信息 ============
function showHelp() {
    console.log(`
QQ经典农场 挂机脚本
====================

用法:
  node client.js --code <登录code> [--wx] [--interval <秒>] [--friend-interval <秒>] [--plant <种子ID>]
  node client.js --qr [--interval <秒>] [--friend-interval <秒>] [--plant <种子ID>]
  node client.js --verify
  node client.js --decode <数据> [--hex] [--gate] [--type <消息类型>]

参数:
  --code              小程序 login() 返回的临时凭证 (必需)
  --qr                启动后使用QQ扫码获取登录code（仅QQ平台）
  --wx                使用微信登录 (默认为QQ小程序)
  --interval          自己农场巡查完成后等待秒数, 默认1秒, 最低1秒
  --friend-interval   好友巡查完成后等待秒数, 默认10秒, 最低1秒
  --plant             指定种植的种子ID (例如: 20002=白萝卜, 20003=胡萝卜)
  --verify            验证proto定义
  --decode            解码PB数据 (运行 --decode 无参数查看详细帮助)

功能:
  - 自动收获成熟作物 → 购买种子 → 种植 → 施肥
  - 自动除草、除虫、浇水
  - 自动铲除枯死作物
  - 自动巡查好友农场: 帮忙浇水/除草/除虫 + 偷菜
  - 自动领取任务奖励 (支持分享翻倍)
  - 每分钟自动出售仓库果实
  - 启动时读取 share.txt 处理邀请码 (仅微信)
  - 心跳保活

邀请码文件 (share.txt):
  每行一个邀请链接，格式: ?uid=xxx&openid=xxx&share_source=xxx&doc_id=xxx
  启动时会尝试通过 SyncAll API 同步这些好友
`);
}

// ============ 参数解析 ============
function parseArgs(args) {
    const options = {
        code: '',
        qrLogin: false,
        deleteAccountMode: false,
        name: '',
        certId: '',
        certType: 0,
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--code' && args[i + 1]) {
            options.code = args[++i];
        } else if (args[i] === '--qr') {
            options.qrLogin = true;
        } else if (args[i] === '--wx') {
            CONFIG.platform = 'wx';
        } else if (args[i] === '--interval' && args[i + 1]) {
            const sec = parseInt(args[++i]);
            CONFIG.farmCheckInterval = Math.max(sec, 1) * 1000;
        } else if (args[i] === '--friend-interval' && args[i + 1]) {
            const sec = parseInt(args[++i]);
            CONFIG.friendCheckInterval = Math.max(sec, 1) * 1000;  // 最低1秒
        } else if (args[i] === '--plant' && args[i + 1]) {
            const inputValue = args[i + 1];
            const seedId = parseInt(inputValue);
            if (!isNaN(seedId)) {
                CONFIG.preferredSeedId = seedId;
            } else {
                console.warn(`[警告] 无效的种子ID: ${inputValue}，将使用自动选择`);
            }
            i++;
        }
    }
    return options;
}

// ============ 主函数 ============
let isReconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 1;
const RECONNECT_LONG_WAIT_MS = parseInt(process.env.RECONNECT_LONG_WAIT_MS) || 60 * 60 * 1000; // 默认1小时
let progressInterval = null; // 等级经验进度定时器（需在断线时清除）
let loginTimeoutAttempts = 0;
const MAX_LOGIN_TIMEOUT_ATTEMPTS = 3;

function calcBackoffDelayMs(attempt) {
    const base = 60000;
    const cap = 300000;
    if (attempt < 1) attempt = 1;
    return Math.min(base * Math.pow(2, attempt - 1), cap);
}

async function startBot(initialOptions) {
    const options = { ...initialOptions };
    
    // QQ 平台支持扫码登录: 显式 --qr，或未传 --code 时自动触发
    if (!options.code && CONFIG.platform === 'qq' && (options.qrLogin || !options.codeProvidedExplicitly)) {
        console.log('[扫码登录] 正在获取二维码...');
        try {
            options.code = await getQQFarmCodeByScan();
            options.usedQrLogin = true;
            console.log(`[扫码登录] 获取成功，code=${options.code.substring(0, 8)}...`);
        } catch (err) {
            console.error(`[扫码登录] 失败: ${err.message}`);
            // 扫码失败时不在这里重试，让调用者决定是否重试
            throw err;
        }
    }

    if (!options.code) {
        if (CONFIG.platform === 'wx') {
            console.log('[参数] 微信模式仍需通过 --code 传入登录凭证');
        }
        return false;
    }

    // 扫码阶段结束后清屏，避免状态栏覆盖二维码区域导致界面混乱
    if (options.usedQrLogin && process.stdout.isTTY) {
        process.stdout.write('\x1b[2J\x1b[H');
    }

    const platformName = CONFIG.platform === 'wx' ? '微信' : 'QQ';
    console.log(`[启动] ${platformName} code=${options.code.substring(0, 8)}... 农场${CONFIG.farmCheckInterval / 1000}s 好友${CONFIG.friendCheckInterval / 1000}s`);

    // 连接并登录，登录成功后启动各功能模块
    connect(options.code, async () => {
        // 重置重连计数（登录成功说明一切正常）
        reconnectAttempts = 0;
        loginTimeoutAttempts = 0;
        
        // 处理邀请码 (仅微信环境)，在登录框关闭（土地统计打印）后执行
        networkEvents.once('loginBoxComplete', () => { processInviteCodes().catch(() => {}); });

        startFarmCheckLoop();
        startFriendCheckLoop();
        initTaskSystem();
        
        // 启动时立即检查一次背包
        setTimeout(() => debugSellFruits(), 5000);
        startSellLoop(60000);  // 每分钟自动出售仓库果实

        // === 新增：每小时打印一次等级经验进度 ===
        const { statusData } = require('./src/status');
        const { getLevelExpProgress } = require('./src/gameConfig');
        const { log } = require('./src/utils');

        if (progressInterval) clearInterval(progressInterval);
        progressInterval = setInterval(() => {
            if (statusData.level > 0) {
                const progress = getLevelExpProgress(statusData.level, statusData.exp);
                // 计算百分比
                const percent = progress.needed > 0 ? Math.floor((progress.current / progress.needed) * 100) : 0;
                log('进度', `当前等级: Lv${statusData.level}, 经验进度: ${progress.current}/${progress.needed} (${percent}%)`);
            }
        }, 60000); // 1小时 = 3600000ms
    });

    return true;
}

async function handleDisconnect(event) {
    if (isReconnecting) {
        console.log(`[断线] 已在重连中，忽略本次事件: ${event.reason}`);
        return; // 避免重复处理
    }
    
    isReconnecting = true;
    console.log(`\n[断线] 原因: ${event.reason}, 消息: ${event.message}`);
    
    // 停止所有循环
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    cleanupTaskSystem();
    stopSellLoop();
    cleanup();
    
    // 清除进度定时器
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    
    // 关闭 WebSocket (close() 对已关闭的连接是安全的)
    const ws = getWs();
    if (ws) {
        try {
            ws.close();
        } catch (e) { }
    }
    
    // 仅 QQ 平台支持自动重连扫码登录
    if (CONFIG.platform === 'qq') {
        if (event.reason === 'login_timeout') {
            loginTimeoutAttempts++;
            if (loginTimeoutAttempts >= MAX_LOGIN_TIMEOUT_ATTEMPTS) {
                console.error(`[断线] 登录超时累计 ${loginTimeoutAttempts} 次，已达上限，退出进程`);
                cleanupStatusBar();
                process.exit(1);
                return;
            }
        }
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            const delayMs = calcBackoffDelayMs(reconnectAttempts);
            console.log(`[重连] 将在 ${delayMs / 1000} 秒后尝试扫码重新登录 (第 ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} 次)`);
            await sleep(delayMs);
            
            isReconnecting = false;
            try {
                // 重新使用扫码登录
                await startBot({ qrLogin: true, codeProvidedExplicitly: false });
            } catch (err) {
                console.error(`[重连] 启动失败: ${err.message}`);
                // 如果启动失败，重置标志以便后续可以再次尝试
                isReconnecting = false;
            }
        } else {
            console.error(`[重连] 已达到最大重试次数 (${MAX_RECONNECT_ATTEMPTS})，等待 ${RECONNECT_LONG_WAIT_MS / 1000} 秒后退出`);
            await sleep(RECONNECT_LONG_WAIT_MS);
            cleanupStatusBar();
            process.exit(1);
        }
    } else {
        console.log('[重连] 微信平台不支持自动重连，需要手动重启并提供新的 code');
        cleanupStatusBar();
        process.exit(1);
    }
}

async function main() {
    const args = process.argv.slice(2);

    // 加载 proto 定义
    await loadProto();

    // 验证模式
    if (args.includes('--verify')) {
        await verifyMode();
        return;
    }

    // 解码模式
    if (args.includes('--decode')) {
        await decodeMode(args);
        return;
    }

    // 正常挂机模式
    const options = parseArgs(args);
    options.codeProvidedExplicitly = args.includes('--code');
    
    if (!options.code && !options.qrLogin && CONFIG.platform === 'wx') {
        showHelp();
        process.exit(1);
    }

    // 初始化状态栏
    initStatusBar();
    setStatusPlatform(CONFIG.platform);
    emitRuntimeHint(true);

    // 监听断线事件，用于自动重连
    const { networkEvents } = require('./src/network');
    networkEvents.on('disconnected', handleDisconnect);

    // 启动机器人
    try {
        const started = await startBot(options);
        if (!started) {
            showHelp();
            cleanupStatusBar();
            process.exit(1);
        }
    } catch (err) {
        console.error(`[启动] 失败: ${err.message}`);
        // 如果是首次启动失败，尝试重连
        if (CONFIG.platform === 'qq' && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            await handleDisconnect({ reason: 'startup_failed', message: err.message });
        } else {
            cleanupStatusBar();
            process.exit(1);
        }
    }

    // 退出处理
    process.on('SIGINT', () => {
        cleanupStatusBar();
        console.log('\n[退出] 正在断开...');
        stopFarmCheckLoop();
        stopFriendCheckLoop();
        cleanupTaskSystem();
        stopSellLoop();
        if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
        cleanup();
        const ws = getWs();
        if (ws) ws.close();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});
