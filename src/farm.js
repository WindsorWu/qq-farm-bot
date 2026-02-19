/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const protobuf = require('protobufjs');
const { CONFIG, PlantPhase, PHASE_NAMES } = require('./config');
const { types } = require('./proto');
const { sendMsgAsync, getUserState, networkEvents, completeLoginBox } = require('./network');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep } = require('./utils');
const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getItemName } = require('./gameConfig');
const { getPlantingRecommendation } = require('../tools/calc-exp-yield');

// ============ 内部状态 ============
let isCheckingFarm = false;
let farmCheckTimer = null;
let farmLoopRunning = false;
let landStatsTimer = null;
let lastLandStats = null;

const EXPAND_RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10分钟重试间隔
const upgradeRetryCooldown = new Map(); // landId -> lastFailedMs
const unlockRetryCooldown = new Map(); // landId -> lastFailedMs

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
    onOperationLimitsUpdate = callback;
}

async function getAllLands() {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

async function harvest(landIds) {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds) {
    const state = getUserState();
    const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    return types.WaterLandReply.decode(replyBody);
}

async function weedOut(landIds) {
    const state = getUserState();
    const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    return types.WeedOutReply.decode(replyBody);
}

async function insecticide(landIds) {
    const state = getUserState();
    const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    return types.InsecticideReply.decode(replyBody);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch (e) {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

async function removePlant(landIds) {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

/**
 * 解锁土地 - 逐块进行，避免批量拒绝
 * @param {number[]} landIds - 要解锁的土地ID列表
 * @returns {Promise<{successCount: number, successIds: number[], failedIds: number[]}>} 解锁结果
 */
async function unlockLand(landIds) {
    let successCount = 0;
    const successIds = [];
    const failedIds = [];
    
    for (const landId of landIds) {
        try {
            const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
                land_ids: [toLong(landId)],
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
            types.UnlockLandReply.decode(replyBody);
            successCount++;
            successIds.push(landId);
            log('解锁', `✓ 土地#${landId} 已解锁`);
        } catch (e) {
            logWarn('解锁', `土地#${landId} 失败: ${e.message}`);
            failedIds.push(landId);
        }
        if (landIds.length > 1) await sleep(200);  // 200ms 间隔
    }
    
    return { successCount, successIds, failedIds };
}

/**
 * 升级土地 - 逐块进行，避免批量拒绝
 * @param {number[]} landIds - 要升级的土地ID列表
 * @returns {Promise<{successCount: number, successIds: number[]}>} 成功升级的土地数量和ID列表
 */
async function upgradeLand(landIds) {
    let successCount = 0;
    const successIds = [];
    const failedIds = [];
    
    for (const landId of landIds) {
        try {
            const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
                land_ids: [toLong(landId)],
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
            types.UpgradeLandReply.decode(replyBody);
            successCount++;
            successIds.push(landId);
            log('升级', `✓ 土地#${landId} 已升级`);
        } catch (e) {
            logWarn('升级', `土地#${landId} 失败: ${e.message}`);
            failedIds.push(landId);
        }
        if (landIds.length > 1) await sleep(200);  // 200ms 间隔
    }
    
    return { successCount, successIds, failedIds };
}

// ============ 商店 API ============

async function getShopInfo(shopId) {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId, num, price) {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

// ============ 种植 ============

function encodePlantRequest(seedId, landIds) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用 50ms
 */
async function plantSeeds(seedId, landIds) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = encodePlantRequest(seedId, [landId]);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            types.PlantReply.decode(replyBody);
            successCount++;
        } catch (e) {
            logWarn('种植', `土地#${landId} 失败: ${e.message}`);
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

async function findBestSeed(landsCount) {
    const SEED_SHOP_ID = 2;
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return null;
    }

    const state = getUserState();
    const available = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions = true;
        let requiredLevel = 0;
        const conds = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    // 如果用户指定了种子ID，优先使用
    if (CONFIG.preferredSeedId) {
        const preferred = available.find(x => x.seedId === CONFIG.preferredSeedId);
        if (preferred) {
            return preferred;
        } else {
            logWarn('商店', `指定的种子ID ${CONFIG.preferredSeedId} 不可用，使用自动选择`);
        }
    }

    if (CONFIG.forceLowestLevelCrop) {
        available.sort((a, b) => a.requiredLevel - b.requiredLevel || a.price - b.price);
        return available[0];
    }

    try {
        log('商店', `等级: ${state.level}，土地数量: ${landsCount}`);
        
        const rec = getPlantingRecommendation(state.level, landsCount == null ? 18 : landsCount, { top: 50 });
        const rankedSeedIds = rec.candidatesNormalFert.map(x => x.seedId);
        for (const seedId of rankedSeedIds) {
            const hit = available.find(x => x.seedId === seedId);
            if (hit) return hit;
        }
    } catch (e) {
        logWarn('商店', `经验效率推荐失败，使用兜底策略: ${e.message}`);
    }

    // 兜底：等级在28级以前还是白萝卜比较好，28级以上选最高等级的种子
    if(state.level && state.level <= 28){
        available.sort((a, b) => a.requiredLevel - b.requiredLevel);
    }else{
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }
    return available[0];
}

async function autoPlantEmptyLands(deadLandIds, emptyLandIds, unlockedLandCount) {
    let landsToPlant = [...emptyLandIds];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作）
    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`);
            landsToPlant.push(...deadLandIds);
        } catch (e) {
            logWarn('铲除', `批量铲除失败: ${e.message}`);
            // 失败时仍然尝试种植
            landsToPlant.push(...deadLandIds);
        }
    }

    if (landsToPlant.length === 0) return;

    // 2. 查询种子商店
    let bestSeed;
    try {
        bestSeed = await findBestSeed(unlockedLandCount);
    } catch (e) {
        logWarn('商店', `查询失败: ${e.message}`);
        return;
    }
    if (!bestSeed) return;

    const seedName = getPlantNameBySeedId(bestSeed.seedId);
    const growTime = getPlantGrowTime(1020000 + (bestSeed.seedId - 20000));  // 转换为植物ID
    const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
    log('商店', `最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`);

    // 3. 购买
    const needCount = landsToPlant.length;
    const totalCost = bestSeed.price * needCount;
    if (totalCost > state.gold) {
        logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`);
        const canBuy = Math.floor(state.gold / bestSeed.price);
        if (canBuy <= 0) return;
        landsToPlant = landsToPlant.slice(0, canBuy);
        log('商店', `金币有限，只种 ${canBuy} 块地`);
    }

    let actualSeedId = bestSeed.seedId;
    try {
        const buyReply = await buyGoods(bestSeed.goodsId, landsToPlant.length, bestSeed.price);
        if (buyReply.get_items && buyReply.get_items.length > 0) {
            const gotItem = buyReply.get_items[0];
            const gotId = toNum(gotItem.id);
            const gotCount = toNum(gotItem.count);
            log('购买', `获得物品: ${getItemName(gotId)}(${gotId}) x${gotCount}`);
            if (gotId > 0) actualSeedId = gotId;
        }
        if (buyReply.cost_items) {
            for (const item of buyReply.cost_items) {
                state.gold -= toNum(item.count);
            }
        }
        const boughtName = getPlantNameBySeedId(actualSeedId);
        log('购买', `已购买 ${boughtName}种子 x${landsToPlant.length}, 花费 ${bestSeed.price * landsToPlant.length} 金币`);
    } catch (e) {
        logWarn('购买', e.message);
        return;
    }

    // 4. 种植（逐块拖动，间隔50ms）
    let plantedLands = [];
    try {
        const planted = await plantSeeds(actualSeedId, landsToPlant);
        log('种植', `已在 ${planted} 块地种植 (${landsToPlant.join(',')})`);
        if (planted > 0) {
            plantedLands = landsToPlant.slice(0, planted);
        }
    } catch (e) {
        logWarn('种植', e.message);
    }

    // 5. 施肥（逐块拖动，间隔50ms）
    if (plantedLands.length > 0) {
        const fertilized = await fertilize(plantedLands);
        if (fertilized > 0) {
            log('施肥', `已为 ${fertilized}/${plantedLands.length} 块地施肥`);
        }
    }
}

// ============ 土地分析 ============

/**
 * 统计各类型土地数量
 */
function getLandTypeCounts(lands) {
    let total = 0, red = 0, black = 0, gold = 0;
    let upgradeCount = 0, unlockCount = 0;

    for (const land of lands) {
        total++;
        if (land.could_unlock && !land.unlocked) {
            unlockCount++;
        }
        if (!land.unlocked) continue;

        const level = toNum(land.level);
        if (level === 2) red++;
        else if (level === 3) black++;
        else if (level === 4) gold++;

        if (land.could_upgrade) upgradeCount++;
    }

    return { total, red, black, gold, upgradeCount, unlockCount };
}

/**
 * 根据服务器时间确定当前实际生长阶段
 */
function getCurrentPhase(phases, debug, landLabel) {
    if (!phases || phases.length === 0) return null;

    const nowSec = getServerTimeSec();

    if (debug) {
        console.log(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        for (let i = 0; i < phases.length; i++) {
            const p = phases[i];
            const bt = toTimeSec(p.begin_time);
            const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
            const diff = bt > 0 ? (bt - nowSec) : 0;
            const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.log(`    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
        }
    }

    for (let i = phases.length - 1; i >= 0; i--) {
        const beginTime = toTimeSec(phases[i].begin_time);
        if (beginTime > 0 && beginTime <= nowSec) {
            if (debug) {
                console.log(`    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`);
            }
            return phases[i];
        }
    }

    if (debug) {
        console.log(`    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
    }
    return phases[0];
}

function analyzeLands(lands) {
    const result = {
        harvestable: [], needWater: [], needWeed: [], needBug: [],
        growing: [], empty: [], dead: [],
        harvestableInfo: [],  // 收获植物的详细信息 { id, name, exp }
        eligibleForUnlock: [],  // 可以解锁的土地
        eligibleForUpgrade: [], // 可以升级的土地
    };

    const nowSec = getServerTimeSec();
    const debug = false;

    if (debug) {
        console.log('');
        console.log('========== 首次巡田详细日志 ==========');
        console.log(`  服务器时间(秒): ${nowSec}  (${new Date(nowSec * 1000).toLocaleString()})`);
        console.log(`  总土地数: ${lands.length}`);
        console.log('');
    }

    for (const land of lands) {
        const id = toNum(land.id);
        
        // 检查是否可以解锁
        if (land.could_unlock && !land.unlocked) {
            result.eligibleForUnlock.push(id);
            if (debug) console.log(`  土地#${id}: 未解锁但可解锁`);
        }
        
        if (!land.unlocked) {
            if (debug) console.log(`  土地#${id}: 未解锁`);
            continue;
        }

        const plant = land.plant;
        const isEmpty = !plant || !plant.phases || plant.phases.length === 0;
        
        // 检查是否可以升级 (已解锁的土地，无论是否有作物)
        if (land.could_upgrade && land.unlocked) {
            result.eligibleForUpgrade.push(id);
            if (debug) console.log(`  土地#${id}: 可升级`);
        }
        
        if (isEmpty) {
            result.empty.push(id);
            if (debug) console.log(`  土地#${id}: 空地`);
            continue;
        }

        const plantName = plant.name || '未知作物';
        const landLabel = `土地#${id}(${plantName})`;

        if (debug) {
            console.log(`  ${landLabel}: phases=${plant.phases.length} dry_num=${toNum(plant.dry_num)} weed_owners=${(plant.weed_owners||[]).length} insect_owners=${(plant.insect_owners||[]).length}`);
        }

        const currentPhase = getCurrentPhase(plant.phases, debug, landLabel);
        if (!currentPhase) {
            result.empty.push(id);
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.DEAD) {
            result.dead.push(id);
            if (debug) console.log(`    → 结果: 枯死`);
            continue;
        }

        if (phaseVal === PlantPhase.MATURE) {
            result.harvestable.push(id);
            // 收集植物信息用于日志
            const plantId = toNum(plant.id);
            const plantNameFromConfig = getPlantName(plantId);
            const plantExp = getPlantExp(plantId);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: plantNameFromConfig || plantName,
                exp: plantExp,
            });
            if (debug) console.log(`    → 结果: 可收获 (${plantNameFromConfig} +${plantExp}经验)`);
            continue;
        }

        let landNeeds = [];
        const dryNum = toNum(plant.dry_num);
        const dryTime = toTimeSec(currentPhase.dry_time);
        if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
            result.needWater.push(id);
            landNeeds.push('缺水');
        }

        const weedsTime = toTimeSec(currentPhase.weeds_time);
        const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
        if (hasWeeds) {
            result.needWeed.push(id);
            landNeeds.push('有草');
        }

        const insectTime = toTimeSec(currentPhase.insect_time);
        const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
        if (hasBugs) {
            result.needBug.push(id);
            landNeeds.push('有虫');
        }

        result.growing.push(id);
        if (debug) {
            const needStr = landNeeds.length > 0 ? ` 需要: ${landNeeds.join(',')}` : '';
            console.log(`    → 结果: 生长中(${PHASE_NAMES[phaseVal] || phaseVal})${needStr}`);
        }
    }

    if (debug) {
        console.log('');
        console.log('========== 巡田分析汇总 ==========');
        console.log(`  可收获: ${result.harvestable.length} [${result.harvestable.join(',')}]`);
        console.log(`  生长中: ${result.growing.length} [${result.growing.join(',')}]`);
        console.log(`  缺水:   ${result.needWater.length} [${result.needWater.join(',')}]`);
        console.log(`  有草:   ${result.needWeed.length} [${result.needWeed.join(',')}]`);
        console.log(`  有虫:   ${result.needBug.length} [${result.needBug.join(',')}]`);
        console.log(`  空地:   ${result.empty.length} [${result.empty.join(',')}]`);
        console.log(`  枯死:   ${result.dead.length} [${result.dead.join(',')}]`);
        console.log('====================================');
        console.log('');
    }

    return result;
}

// ============ 巡田主循环 ============

async function checkFarm() {
    const state = getUserState();
    if (isCheckingFarm || !state.gid) return;
    isCheckingFarm = true;

    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands || landsReply.lands.length === 0) {
            log('农场', '没有土地数据');
            completeLoginBox(null);
            return;
        }

        const lands = landsReply.lands;
        const landStats = getLandTypeCounts(lands);
        lastLandStats = landStats;

        // 首次巡田：完成登录成功框（追加土地统计）
        completeLoginBox(landStats);

        const status = analyzeLands(lands);
        const unlockedLandCount = lands.filter(land => land && land.unlocked).length;

        // 构建状态摘要
        const statusParts = [];
        if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
        if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
        if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
        if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
        if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
        if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
        statusParts.push(`长:${status.growing.length}`);

        const hasWork = status.harvestable.length || status.needWeed.length || status.needBug.length
            || status.needWater.length || status.dead.length || status.empty.length;

        // 执行操作并收集结果
        const actions = [];

        // 一键操作：除草、除虫、浇水可以并行执行（游戏中都是一键完成）
        const batchOps = [];
        if (status.needWeed.length > 0) {
            batchOps.push(weedOut(status.needWeed).then(() => actions.push(`除草${status.needWeed.length}`)).catch(e => logWarn('除草', e.message)));
        }
        if (status.needBug.length > 0) {
            batchOps.push(insecticide(status.needBug).then(() => actions.push(`除虫${status.needBug.length}`)).catch(e => logWarn('除虫', e.message)));
        }
        if (status.needWater.length > 0) {
            batchOps.push(waterLand(status.needWater).then(() => actions.push(`浇水${status.needWater.length}`)).catch(e => logWarn('浇水', e.message)));
        }
        if (batchOps.length > 0) {
            await Promise.all(batchOps);
        }

        // 收获（一键操作）
        let harvestedLandIds = [];
        if (status.harvestable.length > 0) {
            try {
                await harvest(status.harvestable);
                actions.push(`收获${status.harvestable.length}`);
                harvestedLandIds = [...status.harvestable];
                // 收获后清除升级冷却，让刚收获的空地可立即重试升级
                for (const id of harvestedLandIds) upgradeRetryCooldown.delete(id);
            } catch (e) { logWarn('收获', e.message); }
        }

        // 解锁土地（如果配置开启）- 收割后、种植前执行
        if (CONFIG.autoExpandLand && status.eligibleForUnlock.length > 0) {
            const now = Date.now();
            const toUnlock = status.eligibleForUnlock.filter(id => {
                const t = unlockRetryCooldown.get(id);
                return !t || now - t >= EXPAND_RETRY_INTERVAL_MS;
            });
            if (toUnlock.length > 0) {
                try {
                    const { successCount, successIds, failedIds } = await unlockLand(toUnlock);
                    const failedTime = Date.now();
                    for (const id of failedIds) unlockRetryCooldown.set(id, failedTime);
                    for (const id of successIds) unlockRetryCooldown.delete(id);
                    if (successCount > 0) {
                        actions.push(`解锁${successCount}`);
                        // 添加明确的提醒日志，便于操作员注意
                        log('农场', `🎉 已自动解锁 ${successCount} 块土地: [${successIds.join(', ')}]`);
                    } else {
                        logWarn('农场', `解锁土地失败: ${toUnlock.length} 块土地均未成功解锁，10分钟后重试`);
                    }
                } catch (e) { logWarn('解锁', e.message); }
            }
        }

        // 升级土地（如果配置开启）- 收割后、种植前执行
        let failedUpgradeIds = [];
        if (CONFIG.autoUpgradeRedLand && status.eligibleForUpgrade.length > 0) {
            const now = Date.now();
            const toUpgrade = status.eligibleForUpgrade.filter(id => {
                const t = upgradeRetryCooldown.get(id);
                return !t || now - t >= EXPAND_RETRY_INTERVAL_MS;
            });
            if (toUpgrade.length > 0) {
                try {
                    const { successCount, successIds, failedIds } = await upgradeLand(toUpgrade);
                    const failedTime = Date.now();
                    for (const id of failedIds) upgradeRetryCooldown.set(id, failedTime);
                    for (const id of successIds) upgradeRetryCooldown.delete(id);
                    if (successCount > 0) {
                        actions.push(`升级${successCount}`);
                        // 添加明确的提醒日志，便于操作员注意
                        log('农场', `⬆️ 已自动升级 ${successCount} 块土地: [${successIds.join(', ')}]`);
                    } else {
                        logWarn('农场', `升级土地失败: ${toUpgrade.length} 块土地均未成功升级，10分钟后重试`);
                    }
                    failedUpgradeIds = failedIds;
                } catch (e) { logWarn('升级', e.message); }
            }
        }

        // 铲除 + 种植 + 施肥（需要顺序执行）
        // 排除升级候选土地（含冷却中的土地），等升级完成后再种植
        const upgradeEligibleSet = new Set(status.eligibleForUpgrade);
        const failedUpgradeSet = new Set(failedUpgradeIds);
        // 枯死土地直接加入，autoPlantEmptyLands 会先铲除再补种
        const allDeadLands = [...status.dead, ...harvestedLandIds.filter(id => !failedUpgradeSet.has(id))];
        const allEmptyLands = status.empty.filter(id => !upgradeEligibleSet.has(id));
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                await autoPlantEmptyLands(allDeadLands, allEmptyLands, unlockedLandCount);
                actions.push(`种植${allDeadLands.length + allEmptyLands.length}`);
            } catch (e) { logWarn('种植', e.message); }
        }

        // 输出一行日志
        const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
        if(hasWork) {
            log('农场', `[${statusParts.join(' ')}]${actionStr}${!hasWork ? ' 无需操作' : ''}`)
        }
    } catch (err) {
        completeLoginBox(null);
        logWarn('巡田', `检查失败: ${err.message}`);
    } finally {
        isCheckingFarm = false;
    }
}

/**
 * 农场巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function farmCheckLoop() {
    while (farmLoopRunning) {
        await checkFarm();
        if (!farmLoopRunning) break;
        await sleep(CONFIG.farmCheckInterval);
    }
}

function startFarmCheckLoop() {
    if (farmLoopRunning) return;
    farmLoopRunning = true;

    // 监听服务器推送的土地变化事件
    networkEvents.on('landsChanged', onLandsChangedPush);

    // 延迟 2 秒后启动循环
    farmCheckTimer = setTimeout(() => farmCheckLoop(), 2000);

    // 每5分钟输出土地统计摘要
    landStatsTimer = setInterval(() => {
        if (lastLandStats) {
            log('土地', `总${lastLandStats.total}块 | 红:${lastLandStats.red} 黑:${lastLandStats.black} 金:${lastLandStats.gold} | 可升级:${lastLandStats.upgradeCount} 可解锁:${lastLandStats.unlockCount}`);
        }
    }, 5 * 60 * 1000);
}

/**
 * 处理服务器推送的土地变化
 */
let lastPushTime = 0;
function onLandsChangedPush(lands) {
    if (isCheckingFarm) return;
    const now = Date.now();
    if (now - lastPushTime < 500) return;  // 500ms 防抖
    
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`);
    
    setTimeout(async () => {
        if (!isCheckingFarm) {
            await checkFarm();
        }
    }, 100);
}

function stopFarmCheckLoop() {
    farmLoopRunning = false;
    if (farmCheckTimer) { clearTimeout(farmCheckTimer); farmCheckTimer = null; }
    if (landStatsTimer) { clearInterval(landStatsTimer); landStatsTimer = null; }
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
}

/**
 * 登录后立即执行一次土地解锁/升级
 * 在每次成功登录后调用，确保符合条件的土地立即得到处理
 */
async function expandLandsOnLogin() {
    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands || landsReply.lands.length === 0) return;

        const status = analyzeLands(landsReply.lands);

        // 登录时清除冷却记录，确保每次登录都立即尝试解锁/升级
        upgradeRetryCooldown.clear();
        unlockRetryCooldown.clear();

        if (CONFIG.autoExpandLand && status.eligibleForUnlock.length > 0) {
            const { successCount, successIds } = await unlockLand(status.eligibleForUnlock);
            if (successCount > 0) {
                log('农场', `🎉 登录后自动解锁 ${successCount} 块土地: [${successIds.join(', ')}]`);
            } else {
                logWarn('农场', `登录后解锁土地失败: ${status.eligibleForUnlock.length} 块土地均未成功解锁`);
            }
        }

        if (CONFIG.autoUpgradeRedLand && status.eligibleForUpgrade.length > 0) {
            const { successCount, successIds } = await upgradeLand(status.eligibleForUpgrade);
            if (successCount > 0) {
                log('农场', `⬆️ 登录后自动升级 ${successCount} 块土地: [${successIds.join(', ')}]`);
            } else {
                logWarn('农场', `登录后升级土地失败: ${status.eligibleForUpgrade.length} 块土地均未成功升级`);
            }
        }
    } catch (e) {
        logWarn('农场', `登录后扩展检查失败: ${e.message}`);
    }
}

module.exports = {
    checkFarm, startFarmCheckLoop, stopFarmCheckLoop,
    expandLandsOnLogin,
    getCurrentPhase,
    setOperationLimitsCallback,
};
