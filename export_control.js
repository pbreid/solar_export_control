// Energy Management State Machine for Node-RED Function Node with Enhanced Logging
// Place this code in a Node-RED function node

// =============================================================================
// CONFIGURATION - Update these values as needed
// =============================================================================

// Monthly Export Targets (kWh per day)
const MONTHLY_EXPORT_TARGETS = {
    1: 25.5,   // January
    2: 30.5,   // February  
    3: 24.5,   // March
    4: 23.5,   // April
    5: 23.2,   // May
    6: 22.8,   // June
    7: 23.5,   // July
    8: 24.3,   // August
    9: 31.1,   // September
    10: 38.4,  // October
    11: 35.2,  // November
    12: 34.9   // December
};

// System Configuration
const CONFIG = {
    // Battery SOC thresholds
    max_soc_threshold: 99,      // % - Switch to load management
    min_soc_threshold: 35,      // % - Switch back to grid consumption

    // HWS Control
    hws_power_rating: 3000,     // W - Hot water system power
    hws_soc_drop_threshold: 2,  // % - SOC drop to turn off HWS
    hws_generation_drop_threshold: 1000, // W - Generation drop to turn off HWS
    hws_cooldown_period: 10,    // minutes - Prevent rapid cycling

    // Reset to export priority logic
    export_target_percentage: 40,  // % - If daily export < this % of target AND battery charging
    battery_charging_threshold: 50, // W - Minimum power to consider "charging" (noise filter)
    strong_charging_threshold: 1000, // W - Strong battery charging indicates significant excess solar
    min_generation_for_export: 500, // W - Minimum solar generation needed to switch to export mode
    min_generation_to_stay_export: 300, // W - Minimum generation to stay in export mode (hysteresis)
    evening_self_consume_soc_threshold: 35, // % - Min SOC + buffer to enable evening self-consume

    // State change debouncing
    state_change_debounce_time: 5,   // minutes - Conditions must persist before switching states

    // Safety & Data Validation
    data_freshness_limit: 5,    // minutes - Max age of data before fallback
    max_reasonable_soc: 105,    // % - Upper bound for SOC validation
    min_reasonable_soc: -5,     // % - Lower bound for SOC validation
    max_reasonable_power: 50000, // W - Upper bound for power validation

    // Stale generation data protection
    significant_export_threshold: 2000, // W - If exporting >2kW, assume generation is working regardless of sensor

    // Time-based logic
    night_start_hour: 20,       // Hour (24h format) when night period starts
    night_end_hour: 6,          // Hour (24h format) when night period ends

    // Debug
    enable_debug: true,

    // Enhanced Logging Configuration
    enable_persistent_logging: true,
    max_log_entries: 100,       // Keep last 100 log entries (reduced for UI display)
    log_hws_changes: true,      // Log all HWS on/off events
    log_state_changes: true,    // Log all state transitions
    log_daily_summary: true,    // Log daily summary at midnight
    log_system_info: true,      // Log periodic system information
    log_performance_alerts: true, // Log performance-related alerts
    
    // Log retention and cleanup
    log_cleanup_enabled: true,  // Enable automatic log cleanup
    log_cleanup_interval_hours: 24, // How often to clean up logs (hours)
    log_max_age_days: 7,       // Maximum age of logs to keep (days)

    // Adaptive Targets
    catchup_days: 5             // Days over which to distribute catch-up deficit
};

// =============================================================================
// STATE MACHINE DEFINITIONS
// =============================================================================

const STATES = {
    EXPORT_PRIORITY: 'EXPORT_PRIORITY',
    BATTERY_STORAGE: 'BATTERY_STORAGE',
    LOAD_MANAGEMENT: 'LOAD_MANAGEMENT',
    SELF_CONSUME: 'SELF_CONSUME',
    SAFE_MODE: 'SAFE_MODE'
};

// =============================================================================
// ENHANCED LOGGING SYSTEM
// =============================================================================

function addPersistentLog(logType, message, data = {}, priority = 'normal') {
    if (!CONFIG.enable_persistent_logging) return;

    // Get existing logs
    let logs = global.get('energy_management_logs', 'file') || [];

    // Create log entry with enhanced metadata
    const logEntry = {
        timestamp: getLocalISOString(),
        type: logType,
        message: message,
        data: data,
        priority: priority, // low, normal, high, critical
        date: getLocalDateString(), // For easy daily filtering
        id: Date.now() + Math.random().toString(36).substr(2, 9) // Unique ID
    };

    // Add to logs
    logs.push(logEntry);

    // Keep only recent entries (maintain max count)
    if (logs.length > CONFIG.max_log_entries) {
        logs = logs.slice(-CONFIG.max_log_entries);
    }

    // Save back to persistent storage
    global.set('energy_management_logs', logs, 'file');

    // Also log to Node-RED console if debug enabled
    if (CONFIG.enable_debug) {
        const priorityPrefix = priority === 'critical' ? '[CRITICAL]' : 
                              priority === 'high' ? '[HIGH]' : 
                              priority === 'low' ? '[LOW]' : '';
        node.log(`${priorityPrefix}[${logType}] ${message}`);
    }

    // Trigger log cleanup if needed
    if (CONFIG.log_cleanup_enabled) {
        cleanupOldLogs();
    }
}

function cleanupOldLogs() {
    // Check if cleanup is due
    const lastCleanup = global.get('last_log_cleanup', 'file') || 0;
    const cleanupInterval = CONFIG.log_cleanup_interval_hours * 60 * 60 * 1000; // Convert to ms
    const now = Date.now();

    if (now - lastCleanup < cleanupInterval) {
        return; // Not time for cleanup yet
    }

    // Get logs and filter by age
    let logs = global.get('energy_management_logs', 'file') || [];
    const maxAge = CONFIG.log_max_age_days * 24 * 60 * 60 * 1000; // Convert to ms
    const cutoffTime = now - maxAge;

    const initialCount = logs.length;
    logs = logs.filter(log => {
        try {
            const logTime = new Date(log.timestamp).getTime();
            return logTime > cutoffTime;
        } catch (e) {
            // If timestamp is invalid, keep the log
            return true;
        }
    });

    // If we cleaned up some logs, save and log the action
    if (logs.length < initialCount) {
        global.set('energy_management_logs', logs, 'file');
        addPersistentLog('SYSTEM', `Log cleanup: removed ${initialCount - logs.length} old entries`, {
            removed_count: initialCount - logs.length,
            remaining_count: logs.length,
            cutoff_age_days: CONFIG.log_max_age_days
        }, 'low');
    }

    // Update last cleanup time
    global.set('last_log_cleanup', now, 'file');
}

function logPerformanceAlert(alertType, message, data = {}) {
    if (!CONFIG.log_performance_alerts) return;
    
    addPersistentLog('PERFORMANCE_ALERT', `${alertType}: ${message}`, data, 'high');
}

function logSystemInfo(message, data = {}) {
    if (!CONFIG.log_system_info) return;
    
    addPersistentLog('SYSTEM_INFO', message, data, 'low');
}

// =============================================================================
// HELPER FUNCTIONS (keeping existing functions with enhanced logging)
// =============================================================================

// --- Local Time Helpers for EST (GMT+10) ---
function getLocalDate(offsetHours = 10) {
    const now = new Date();
    const localTime = new Date(now.getTime() + (offsetHours * 60 * 60 * 1000));
    return localTime;
}

function getLocalISOString(offsetHours = 10) {
    const local = getLocalDate(offsetHours);
    return local.toISOString().replace('Z', '+10:00');
}

function getLocalDateString(offsetHours = 10) {
    const local = getLocalDate(offsetHours);
    return local.toISOString().split('T')[0];
}

// --- Debouncing Functions ---
function checkStateChangeDebounce(targetState, currentState, reason) {
    if (targetState === currentState) {
        return { allowed: true, reason: 'No state change required' };
    }

    const now = Date.now();
    const stateChangeKey = `${currentState}_to_${targetState}`;
    const lastRequestTime = global.get(`state_change_request_${stateChangeKey}`) || 0;
    const debounceMs = CONFIG.state_change_debounce_time * 60 * 1000;

    if (lastRequestTime === 0) {
        global.set(`state_change_request_${stateChangeKey}`, now);
        addPersistentLog('DEBOUNCE', `State change request started: ${currentState} → ${targetState}`, {
            transition: stateChangeKey,
            reason: reason,
            debounce_time: CONFIG.state_change_debounce_time
        });
        return { allowed: false, reason: `Debouncing state change (${CONFIG.state_change_debounce_time}min required)` };
    }

    const timeSinceRequest = now - lastRequestTime;
    if (timeSinceRequest >= debounceMs) {
        global.set(`state_change_request_${stateChangeKey}`, 0);
        addPersistentLog('DEBOUNCE', `State change approved: ${currentState} → ${targetState}`, {
            transition: stateChangeKey,
            time_waited: Math.round(timeSinceRequest / 1000),
            reason: reason
        });
        return { allowed: true, reason: 'Debounce period satisfied' };
    } else {
        const remainingTime = Math.round((debounceMs - timeSinceRequest) / 1000);
        return {
            allowed: false,
            reason: `Debouncing (${remainingTime}s remaining)`
        };
    }
}

function clearOtherStateChangeRequests(allowedTransition) {
    const allStates = Object.values(STATES);
    allStates.forEach(fromState => {
        allStates.forEach(toState => {
            const transition = `${fromState}_to_${toState}`;
            if (transition !== allowedTransition) {
                global.set(`state_change_request_${transition}`, 0);
            }
        });
    });
}

function updateDailyExportHistory(dailyExport, targetExport) {
    const currentDate = getLocalDateString();
    global.set('export_history_30days', undefined);
    let exportHistory = global.get('export_history_30days', 'file') || [];

    const todayIndex = exportHistory.findIndex(entry => entry.date === currentDate);
    if (todayIndex >= 0) {
        if (CONFIG.enable_debug) {
            node.log(`Export history for today (${currentDate}) already updated. Skipping.`);
        }
        return exportHistory;
    }

    const todayEntry = {
        date: currentDate,
        export: dailyExport,
        target: targetExport,
        timestamp: getLocalISOString()
    };

    exportHistory.push(todayEntry);
    exportHistory = exportHistory
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .slice(-30);

    global.set('export_history_30days', exportHistory, 'file');

    logSystemInfo(`Export history updated: ${dailyExport.toFixed(1)} kWh recorded for ${currentDate}`, {
        daily_export: dailyExport,
        target_export: targetExport,
        history_length: exportHistory.length
    });

    return exportHistory;
}

function getCurrentMonthTarget() {
    const exportHistory = global.get('export_history_30days', 'file') || [];

    if (exportHistory.length > 0) {
        const daysToUse = Math.min(exportHistory.length, 30);
        const recentHistory = exportHistory.slice(-daysToUse);

        const totalExport = recentHistory.reduce((sum, day) => {
            return sum + (day.export || 0);
        }, 0);
        const rollingAverage = totalExport / daysToUse;

        const currentMonth = getLocalDate().getMonth() + 1;
        const staticMonthlyTarget = MONTHLY_EXPORT_TARGETS[currentMonth] || 25.0;

        let adjustedTarget;
        const performance = rollingAverage / staticMonthlyTarget;

        if (performance < 0.9) {
            const expectedTotal = staticMonthlyTarget * daysToUse;
            const actualTotal = totalExport;
            const totalDeficit = expectedTotal - actualTotal;
            const catchupDays = CONFIG.catchup_days || 5;
            const catchupPerDay = totalDeficit / catchupDays;
            adjustedTarget = staticMonthlyTarget + catchupPerDay;
            adjustedTarget = Math.min(adjustedTarget, staticMonthlyTarget * 2.0);
            
            logPerformanceAlert('UNDER_PERFORMING', `Performance ${(performance * 100).toFixed(1)}% of target, activating catch-up mode`, {
                performance_ratio: performance,
                deficit: totalDeficit,
                catchup_per_day: catchupPerDay
            });
        } else if (performance > 1.1) {
            const excess = rollingAverage - staticMonthlyTarget;
            const coolDownReduction = excess * 0.3;
            adjustedTarget = staticMonthlyTarget - coolDownReduction;
            adjustedTarget = Math.max(adjustedTarget, staticMonthlyTarget * 0.8);
            
            logPerformanceAlert('OVER_PERFORMING', `Performance ${(performance * 100).toFixed(1)}% of target, reducing daily target`, {
                performance_ratio: performance,
                excess_per_day: excess,
                reduction: coolDownReduction
            });
        } else {
            adjustedTarget = staticMonthlyTarget;
        }

        const calculatedTarget = {
            base_target: rollingAverage,
            adjusted_target: adjustedTarget,
            static_monthly_target: staticMonthlyTarget,
            monthly_export_target: staticMonthlyTarget * new Date(getLocalDate().getFullYear(), getLocalDate().getMonth() + 1, 0).getDate(),
            performance_ratio: performance,
            method: "rolling_30day",
            rolling_days: daysToUse,
            rolling_export_total: totalExport,
            calculation_date: getLocalISOString(),
            data_points: daysToUse,
            adjustment_reason: performance < 0.9 ? 'under_performing' :
                performance > 1.1 ? 'over_performing' : 'normal',
            shortfall_per_day: performance < 0.9 ? staticMonthlyTarget - rollingAverage : 0,
            excess_per_day: performance > 1.1 ? rollingAverage - staticMonthlyTarget : 0,
            total_deficit: performance < 0.9 ? (staticMonthlyTarget * daysToUse) - totalExport : 0,
            catchup_per_day: performance < 0.9 ? adjustedTarget - staticMonthlyTarget : 0,
            catchup_days_used: CONFIG.catchup_days || 5,
            mixed_month_data: daysToUse > 1 ? checkForMixedMonthData(recentHistory) : false
        };

        global.set('target_calculation', calculatedTarget, 'file');

        if (CONFIG.enable_debug) {
            const mixedMonthInfo = calculatedTarget.mixed_month_data ? ' (mixed month data)' : '';
            node.warn(`Adaptive target: ${adjustedTarget.toFixed(1)} kWh (avg: ${rollingAverage.toFixed(1)}, monthly: ${staticMonthlyTarget.toFixed(1)}, performance: ${(performance * 100).toFixed(1)}%)${mixedMonthInfo}`);
        }

        return adjustedTarget;
    }

    const currentMonth = getLocalDate().getMonth() + 1;
    const staticTarget = MONTHLY_EXPORT_TARGETS[currentMonth] || 25.0;

    logSystemInfo(`Using static monthly target: ${staticTarget} kWh (no export history available)`);

    return staticTarget;
}

function checkForMixedMonthData(historyArray) {
    const months = new Set();
    historyArray.forEach(entry => {
        const month = new Date(entry.date).getMonth() + 1;
        months.add(month);
    });

    return {
        has_mixed_months: months.size > 1,
        months_included: Array.from(months).sort(),
        month_count: months.size
    };
}

function getExcessGeneration(generation, gridPower) {
    return gridPower < 0 ? Math.abs(gridPower) : 0;
}

function shouldResetToExportPriority(dailyExport, targetExport, batteryPower) {
    const exportPercentage = (dailyExport / targetExport) * 100;
    const batteryCharging = batteryPower > CONFIG.strong_charging_threshold;
    return exportPercentage < CONFIG.export_target_percentage && batteryCharging;
}

function isNightTime() {
    const currentHour = getLocalDate().getHours();
    if (CONFIG.night_start_hour > CONFIG.night_end_hour) {
        return currentHour >= CONFIG.night_start_hour || currentHour < CONFIG.night_end_hour;
    } else {
        return currentHour >= CONFIG.night_start_hour && currentHour < CONFIG.night_end_hour;
    }
}

function validateInputData(inputs) {
    const errors = [];

    if (inputs.batterySoc < CONFIG.min_reasonable_soc || inputs.batterySoc > CONFIG.max_reasonable_soc) {
        errors.push(`Battery SOC ${inputs.batterySoc}% outside reasonable bounds`);
    }

    if (Math.abs(inputs.generation) > CONFIG.max_reasonable_power) {
        errors.push(`Generation ${inputs.generation}W outside reasonable bounds`);
    }

    if (Math.abs(inputs.gridPower) > CONFIG.max_reasonable_power) {
        errors.push(`Grid power ${inputs.gridPower}W outside reasonable bounds`);
    }

    if (Math.abs(inputs.batteryPower) > CONFIG.max_reasonable_power) {
        errors.push(`Battery power ${inputs.batteryPower}W outside reasonable bounds`);
    }

    if (inputs.dailyExport < 0 || inputs.dailyExport > 200) {
        errors.push(`Daily export ${inputs.dailyExport}kWh outside reasonable bounds`);
    }

    return errors;
}

function initializeStateIfNeeded() {
    const currentState = global.get('energy_management_state');
    if (!currentState || !Object.values(STATES).includes(currentState)) {
        global.set('energy_management_state', STATES.EXPORT_PRIORITY);
        addPersistentLog('SYSTEM', 'Energy management system initialized', {
            initial_state: STATES.EXPORT_PRIORITY,
            timestamp: getLocalISOString()
        }, 'high');
        return STATES.EXPORT_PRIORITY;
    }
    return currentState;
}

function logHWSEvent(action, reason, hwsStatus, batterySoc, generation) {
    if (!CONFIG.log_hws_changes) return;

    addPersistentLog('HWS_EVENT', `HWS ${action}: ${reason}`, {
        hws_status: hwsStatus,
        battery_soc: batterySoc,
        generation: generation,
        action: action,
        reason: reason
    }, action === 'TURNED_OFF' ? 'normal' : 'low');
}

function logStateChange(fromState, toState, reason, inputs) {
    if (!CONFIG.log_state_changes) return;

    const priority = (fromState === STATES.SAFE_MODE || toState === STATES.SAFE_MODE) ? 'high' : 'normal';
    
    addPersistentLog('STATE_CHANGE', `${fromState} → ${toState}: ${reason}`, {
        from_state: fromState,
        to_state: toState,
        reason: reason,
        daily_export: inputs.dailyExport,
        target_export: inputs.targetExport,
        battery_soc: inputs.batterySoc,
        generation: inputs.generation,
        battery_power: inputs.batteryPower
    }, priority);
}

function logDailySummary(dailyExport, targetExport, inputs) {
    if (!CONFIG.log_daily_summary) return;

    const currentHour = getLocalDate().getHours();
    if (currentHour >= 23 || currentHour <= 1) {
        const lastSummary = global.get('last_daily_summary_date', 'file') || '';
        const today = getLocalDateString();

        if (lastSummary !== today) {
            const performancePercent = ((dailyExport / targetExport) * 100).toFixed(1);
            addPersistentLog('DAILY_SUMMARY', `Daily Summary: ${dailyExport.toFixed(1)}/${targetExport.toFixed(1)} kWh (${performancePercent}%)`, {
                daily_export: dailyExport,
                target_export: targetExport,
                target_achieved: dailyExport >= targetExport,
                battery_soc_end: inputs.batterySoc,
                performance_percent: performancePercent
            }, 'normal');

            global.set('last_daily_summary_date', today, 'file');
        }
    }
}

function getHWSCooldownStatus() {
    const lastHWSoff = global.get('hws_last_off_time') || 0;
    const cooldownExpired = (Date.now() - lastHWSoff) > (CONFIG.hws_cooldown_period * 60 * 1000);
    return cooldownExpired;
}

// =============================================================================
// BATTERY PROTECTION HELPER
// =============================================================================

function isBatteryProtectionActive(batterySoc, batteryPower, exportTargetReached) {
    const socCritical = batterySoc <= CONFIG.min_soc_threshold;
    const batteryDischarging = batteryPower < 0;
    
    return socCritical && batteryDischarging;
}

// =============================================================================
// MAIN STATE MACHINE LOGIC
// =============================================================================

function processStateTransition(currentState, inputs) {
    const {
        dailyExport,
        targetExport,
        generation,
        gridPower,
        batterySoc,
        batteryPower,
        inverterMode
    } = inputs;

    const excessGeneration = getExcessGeneration(generation, gridPower);
    const exportTargetReached = dailyExport >= targetExport;
    const batteryFull = batterySoc >= CONFIG.max_soc_threshold;
    const batteryLow = batterySoc <= CONFIG.min_soc_threshold;
    const batteryCharging = batteryPower > 0;

    let nextState = currentState;
    let stateReason = '';

    // PRIORITY 0: Stale generation data protection
    const exportingSignificantly = gridPower < -CONFIG.significant_export_threshold;
    const generationSuspicious = generation < 500;
    const generationDataStale = exportingSignificantly && generationSuspicious;

    if (currentState === STATES.EXPORT_PRIORITY && generationDataStale) {
        nextState = currentState;
        stateReason = `Maintaining export state: exporting ${Math.abs(gridPower)}W but generation sensor shows only ${generation}W (likely stale)`;

        addPersistentLog('DATA_PROTECTION', `Generation data appears stale: ${generation}W reported but exporting ${Math.abs(gridPower)}W`, {
            reported_generation: generation,
            grid_power: gridPower,
            battery_power: batteryPower,
            action: 'maintaining_export_state'
        }, 'high');

        return { nextState, stateReason };
    }

    // PRIORITY 1: Battery Protection Override
    const batteryProtectionActive = isBatteryProtectionActive(batterySoc, batteryPower, exportTargetReached);
    
    if (batteryProtectionActive) {
        if (currentState !== STATES.EXPORT_PRIORITY) {
            nextState = STATES.EXPORT_PRIORITY;
            stateReason = `Battery protection override: SOC ${batterySoc}% ≤ ${CONFIG.min_soc_threshold}% and discharging ${batteryPower}W - forcing export priority to prevent over-discharge`;

            addPersistentLog('BATTERY_PROTECTION', `Battery protection override triggered: SOC ${batterySoc}%, discharging ${batteryPower}W`, {
                battery_soc: batterySoc,
                battery_power: batteryPower,
                export_target_reached: exportTargetReached,
                daily_export: dailyExport,
                target_export: targetExport,
                previous_state: currentState,
                action: 'forced_export_priority'
            }, 'critical');
        } else {
            stateReason = `Battery protection active: SOC ${batterySoc}% ≤ ${CONFIG.min_soc_threshold}% and discharging ${batteryPower}W - maintaining export priority`;
        }
        
        return { nextState, stateReason };
    }

    // PRIORITY 2: Normal state transition logic
    if (!exportTargetReached && !isNightTime() &&
        (generation >= CONFIG.min_generation_for_export || batteryPower >= CONFIG.strong_charging_threshold)) {
        if (currentState !== STATES.EXPORT_PRIORITY) {
            const debounceCheck = checkStateChangeDebounce(STATES.EXPORT_PRIORITY, currentState,
                `Daily export ${dailyExport.toFixed(1)}kWh has not reached target ${targetExport.toFixed(1)}kWh with ${generation}W generation and ${batteryPower}W battery power`);

            if (debounceCheck.allowed) {
                nextState = STATES.EXPORT_PRIORITY;
                stateReason = `Reset to export priority: ${debounceCheck.reason}`;
                clearOtherStateChangeRequests(`${currentState}_to_${STATES.EXPORT_PRIORITY}`);
            } else {
                stateReason = `Export priority requested but ${debounceCheck.reason}`;
            }
        }
    }
    else if (shouldResetToExportPriority(dailyExport, targetExport, batteryPower) && !isNightTime() &&
        (generation >= CONFIG.min_generation_for_export || batteryPower >= CONFIG.strong_charging_threshold)) {
        const debounceCheck = checkStateChangeDebounce(STATES.EXPORT_PRIORITY, currentState,
            `Daily export ${dailyExport.toFixed(1)}kWh < ${CONFIG.export_target_percentage}% of target ${targetExport.toFixed(1)}kWh and battery charging >${CONFIG.battery_charging_threshold}W with ${generation}W generation and ${batteryPower}W battery power`);

        if (debounceCheck.allowed) {
            nextState = STATES.EXPORT_PRIORITY;
            stateReason = `Reset to export priority: ${debounceCheck.reason}`;
            clearOtherStateChangeRequests(`${currentState}_to_${STATES.EXPORT_PRIORITY}`);
        } else {
            stateReason = `Export priority requested but ${debounceCheck.reason}`;
        }
    }
    else if (currentState === STATES.EXPORT_PRIORITY && !isNightTime() &&
        generation < CONFIG.min_generation_to_stay_export &&
        batteryPower < CONFIG.battery_charging_threshold &&
        batterySoc > CONFIG.min_soc_threshold) {
        
        const debounceCheck = checkStateChangeDebounce(STATES.SELF_CONSUME, currentState,
            `Generation dropped to ${generation}W below stay threshold (${CONFIG.min_generation_to_stay_export}W) and battery power only ${batteryPower}W with safe SOC ${batterySoc}%`);

        if (debounceCheck.allowed) {
            nextState = STATES.SELF_CONSUME;
            stateReason = `Low generation and weak battery charging with safe SOC: ${debounceCheck.reason}`;
            clearOtherStateChangeRequests(`${currentState}_to_${STATES.SELF_CONSUME}`);
        } else {
            stateReason = `Self consume requested but ${debounceCheck.reason}`;
        }
    }
    else {
        switch (currentState) {
            case STATES.EXPORT_PRIORITY:
                if (exportTargetReached) {
                    nextState = STATES.BATTERY_STORAGE;
                    stateReason = `Export target ${targetExport.toFixed(1)}kWh reached, switching to battery storage`;
                } else if (generation < CONFIG.min_generation_for_export &&
                    batterySoc > CONFIG.evening_self_consume_soc_threshold &&
                    !batteryCharging) {
                    nextState = STATES.SELF_CONSUME;
                    stateReason = `Low solar (${generation}W), target not reached, but battery has charge (${batterySoc}%) - self consume to avoid grid import`;
                } else {
                    stateReason = `Export priority: ${dailyExport.toFixed(1)}/${targetExport.toFixed(1)}kWh exported`;
                }
                break;

            case STATES.BATTERY_STORAGE:
                if (batteryFull && excessGeneration > (CONFIG.hws_power_rating * 0.8)) {
                    nextState = STATES.LOAD_MANAGEMENT;
                    stateReason = `Battery full (${batterySoc}%), excess generation ${excessGeneration}W - activating load management`;
                } else if (batteryLow && !batteryCharging) {
                    nextState = STATES.SELF_CONSUME;
                    stateReason = `Battery low (${batterySoc}%) and not charging - switching to self consume`;
                } else if (batteryPower < 0) {
                    nextState = STATES.SELF_CONSUME;
                    stateReason = `Battery discharging ${Math.abs(batteryPower)}W - switching to self consume mode`;
                } else {
                    stateReason = `Battery storage: SOC ${batterySoc}%, storing ${batteryPower}W`;
                }
                break;

            case STATES.LOAD_MANAGEMENT:
                const hwsStatus = global.get('hws_status') || false;
                const socDropped = batterySoc <= (CONFIG.max_soc_threshold - CONFIG.hws_soc_drop_threshold);
                const generationDropped = generation < CONFIG.hws_generation_drop_threshold;

                if ((socDropped || generationDropped) && hwsStatus) {
                    if (batteryLow && !batteryCharging) {
                        nextState = STATES.SELF_CONSUME;
                        stateReason = `Battery low (${batterySoc}%) - switching to self consume`;
                    } else {
                        nextState = STATES.BATTERY_STORAGE;
                        stateReason = `SOC dropped to ${batterySoc}% or generation dropped to ${generation}W - back to battery storage`;
                    }
                } else {
                    stateReason = `Load management: SOC ${batterySoc}%, generation ${generation}W, HWS ${hwsStatus ? 'ON' : 'OFF'}`;
                }
                break;

            case STATES.SELF_CONSUME:
                if (batteryCharging && !exportTargetReached) {
                    nextState = STATES.EXPORT_PRIORITY;
                    stateReason = `Battery charging and export target not reached - back to export priority`;
                } else if (batteryCharging && exportTargetReached) {
                    nextState = STATES.BATTERY_STORAGE;
                    stateReason = `Battery charging and export target reached - back to battery storage`;
                } else {
                    stateReason = `Self consume: SOC ${batterySoc}%, battery power ${batteryPower}W`;
                }
                break;

            default:
                nextState = STATES.SAFE_MODE;
                stateReason = `Unknown state, entering safe mode`;
                addPersistentLog('ERROR', `Unknown state detected: ${currentState}`, {
                    current_state: currentState,
                    valid_states: Object.values(STATES)
                }, 'critical');
        }
    }

    return { nextState, stateReason };
}

// =============================================================================
// OUTPUT GENERATION
// =============================================================================

function generateOutput(state, inputs, stateReason) {
    const {
        dailyExport,
        targetExport,
        generation,
        gridPower,
        batterySoc,
        batteryPower
    } = inputs;

    let output = {
        timestamp: getLocalISOString(),
        current_state: state,
        actions: {
            set_ess_mode: false,
            grid_setpoint: null,
            enable_hws: false,
            inverter_mode: 3
        },
        status: {
            export_target: targetExport,
            daily_export: dailyExport,
            target_reached: dailyExport >= targetExport,
            battery_soc: batterySoc,
            excess_generation: getExcessGeneration(generation, gridPower),
            battery_power: batteryPower,
            battery_protection_active: isBatteryProtectionActive(batterySoc, batteryPower, dailyExport >= targetExport)
        },
        debug: {
            state_reason: stateReason,
            next_check: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }
    };

    // Set actions based on state
    switch (state) {
        case STATES.EXPORT_PRIORITY:
            output.actions.set_ess_mode = false;
            output.actions.inverter_mode = 3;
            break;

        case STATES.BATTERY_STORAGE:
            output.actions.set_ess_mode = true;
            output.actions.grid_setpoint = 0;
            output.actions.inverter_mode = 3;
            break;

        case STATES.LOAD_MANAGEMENT:
            output.actions.set_ess_mode = true;
            output.actions.grid_setpoint = 0;
            output.actions.inverter_mode = 3;

            // HWS control logic
            const hwsStatus = global.get('hws_status') || false;
            const socDropped = batterySoc <= (CONFIG.max_soc_threshold - CONFIG.hws_soc_drop_threshold);
            const generationDropped = generation < CONFIG.hws_generation_drop_threshold;
            const cooldownExpired = getHWSCooldownStatus();

            if (!hwsStatus && cooldownExpired && !socDropped && !generationDropped) {
                output.actions.enable_hws = true;
                logHWSEvent('TURNED_ON', 'Battery full, excess generation available, cooldown expired', true, batterySoc, generation);
            } else if (hwsStatus && (socDropped || generationDropped)) {
                output.actions.enable_hws = false;
                global.set('hws_last_off_time', Date.now());
                logHWSEvent('TURNED_OFF', socDropped ? `SOC dropped to ${batterySoc}%` : `Generation dropped to ${generation}W`, false, batterySoc, generation);
            } else {
                output.actions.enable_hws = hwsStatus;
                if (hwsStatus) {
                    addPersistentLog('HWS_STATUS', `HWS remains ON: SOC ${batterySoc}%, Gen ${generation}W`, {
                        hws_status: true,
                        battery_soc: batterySoc,
                        generation: generation,
                        reason: 'maintaining_current_state'
                    }, 'low');
                }
            }
            break;

        case STATES.SELF_CONSUME:
            output.actions.set_ess_mode = true;
            output.actions.grid_setpoint = 0;
            output.actions.inverter_mode = 3;
            break;

        case STATES.SAFE_MODE:
            output.actions.set_ess_mode = false;
            output.actions.inverter_mode = 4;
            addPersistentLog('ERROR', 'System operating in safe mode', {
                state_reason: stateReason,
                battery_soc: batterySoc,
                generation: generation
            }, 'critical');
            break;
    }

    return output;
}

// =============================================================================
// MAIN EXECUTION
// =============================================================================

try {
    // Check if energy management is enabled
    const energyManagementEnabled = global.get('energy_management_enabled');
    if (energyManagementEnabled === false)
    {
        return;
    }


    // Get input data from global context
    const dailyExport = (global.get('export_daily') || 0) / 1000;
    const gridPower = global.get('grid_power') || 0;
    const generation = global.get('generation') || 0;
    const batterySoc = global.get('victron_soc') || 50;
    const batteryPower = global.get('battery_power') || 0;
    const inverterMode = global.get('victron_mode') || 3;

    // Initialize and get current state
    const currentState = initializeStateIfNeeded();
    const targetExport = getCurrentMonthTarget();

    // Update daily export history
    updateDailyExportHistory(dailyExport, targetExport);

    // Prepare inputs object
    const inputs = {
        dailyExport,
        targetExport,
        generation,
        gridPower,
        batterySoc,
        batteryPower,
        inverterMode
    };

    // Validate input data
    const validationErrors = validateInputData(inputs);
    if (validationErrors.length > 0) {
        addPersistentLog('ERROR', `Data validation failed: ${validationErrors.join(', ')}`, {
            validation_errors: validationErrors,
            input_data: inputs
        }, 'high');

        msg.payload = {
            timestamp: getLocalISOString(),
            current_state: STATES.SAFE_MODE,
            actions: {
                set_ess_mode: false,
                grid_setpoint: null,
                enable_hws: false,
                inverter_mode: 3
            },
            status: {
                validation_errors: validationErrors,
                message: 'Invalid sensor data - using safe mode'
            }
        };
        return msg;
    }

    // Process state transition
    const { nextState, stateReason } = processStateTransition(currentState, inputs);

    // Update global state if changed
    if (nextState !== currentState) {
        global.set('energy_management_state', nextState);
        logStateChange(currentState, nextState, stateReason, inputs);
        if (CONFIG.enable_debug) {
            node.warn(`State change: ${currentState} → ${nextState}`);
        }
    }

    // Log daily summary
    logDailySummary(dailyExport, targetExport, inputs);

    // Generate output
    const output = generateOutput(nextState, inputs, stateReason);

    // Store HWS status for next iteration
    global.set('hws_status', output.actions.enable_hws);

    // Send output
    msg.payload = output;
    return msg;

} catch (error) {
    addPersistentLog('ERROR', `Energy Management Fatal Error: ${error.message}`, {
        error_message: error.message,
        error_stack: error.stack,
        timestamp: getLocalISOString()
    }, 'critical');
    
    node.error(`Energy Management Error: ${error.message}`);
    msg.payload = {
        timestamp: getLocalISOString(),
        current_state: STATES.SAFE_MODE,
        actions: {
            set_ess_mode: false,
            grid_setpoint: null,
            enable_hws: false,
            inverter_mode: 4
        },
        error: error.message
    };
    return msg;
}