#!/usr/bin/env node
/**
 * Simple verification test for land unlock/upgrade features
 */

const { CONFIG } = require('../src/config');
const { loadProto, types } = require('../src/proto');

async function runTests() {
    console.log('🧪 Running verification tests for land unlock/upgrade features...\n');
    
    let passedTests = 0;
    let totalTests = 0;
    
    // Test 1: Config defaults
    totalTests++;
    console.log('Test 1: Verify config defaults');
    if (CONFIG.autoExpandLand === false && CONFIG.autoUpgradeRedLand === false) {
        console.log('  ✓ Config defaults are correct (both false)');
        passedTests++;
    } else {
        console.log('  ✗ Config defaults are incorrect');
        console.log(`    autoExpandLand: ${CONFIG.autoExpandLand} (expected: false)`);
        console.log(`    autoUpgradeRedLand: ${CONFIG.autoUpgradeRedLand} (expected: false)`);
    }
    console.log();
    
    // Test 2: Proto loading
    totalTests++;
    console.log('Test 2: Load proto definitions');
    try {
        await loadProto();
        console.log('  ✓ Proto definitions loaded successfully');
        passedTests++;
    } catch (err) {
        console.log('  ✗ Proto loading failed:', err.message);
    }
    console.log();
    
    // Test 3: Proto types exist
    totalTests++;
    console.log('Test 3: Verify UnlockLand and UpgradeLand types exist');
    if (types.UnlockLandRequest && types.UnlockLandReply && 
        types.UpgradeLandRequest && types.UpgradeLandReply) {
        console.log('  ✓ All required proto types are registered');
        passedTests++;
    } else {
        console.log('  ✗ Some proto types are missing');
        console.log(`    UnlockLandRequest: ${!!types.UnlockLandRequest}`);
        console.log(`    UnlockLandReply: ${!!types.UnlockLandReply}`);
        console.log(`    UpgradeLandRequest: ${!!types.UpgradeLandRequest}`);
        console.log(`    UpgradeLandReply: ${!!types.UpgradeLandReply}`);
    }
    console.log();
    
    // Test 4: Test proto message creation
    totalTests++;
    console.log('Test 4: Test proto message encoding');
    try {
        const unlockReq = types.UnlockLandRequest.create({ land_ids: [1, 2, 3] });
        const unlockEncoded = types.UnlockLandRequest.encode(unlockReq).finish();
        
        const upgradeReq = types.UpgradeLandRequest.create({ land_ids: [4, 5, 6] });
        const upgradeEncoded = types.UpgradeLandRequest.encode(upgradeReq).finish();
        
        if (unlockEncoded.length > 0 && upgradeEncoded.length > 0) {
            console.log('  ✓ Proto messages can be created and encoded');
            passedTests++;
        } else {
            console.log('  ✗ Proto message encoding failed');
        }
    } catch (err) {
        console.log('  ✗ Proto message creation/encoding failed:', err.message);
    }
    console.log();
    
    // Summary
    console.log('═══════════════════════════════════════');
    console.log(`Test Results: ${passedTests}/${totalTests} passed`);
    console.log('═══════════════════════════════════════');
    
    if (passedTests === totalTests) {
        console.log('✅ All tests passed!');
        process.exit(0);
    } else {
        console.log('❌ Some tests failed!');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
