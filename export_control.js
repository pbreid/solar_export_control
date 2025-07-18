// Energy Management State Machine for Node-RED Function Node
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
    min_soc_threshold: 25,      // % - Switch back to grid consumption

    // HWS Control
    hws_power_rating: 3000,     // W - Hot water system power
    hws_soc_drop_threshold: 2,  // % - SOC drop to turn off HWS
    hws_generation_drop_threshold: 1000, // W - Generation drop to turn off HWS
    hws_cooldown_period: 30,    // minutes - Prevent rapid cycling

    // Reset to export priority logic
    export_target_percentage: 40,  // % - If daily export < this % of target AND battery charging
    battery_charging_threshold: 50, // W - Minimum power to consider "charging" (noise filter)
    strong_charging_threshold: 1000, // W - Strong battery charging indicates significant excess solar
    min_generation_for_export: 500, // W - Minimum solar generation needed to switch to export mode
    min_generation_to_stay_export: 300, // W - Minimum generation to stay in export mode (hysteresis)
    evening_self_consume_soc_threshold: 30, // % - Min SOC + buffer to enable evening self-consume

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

    catchup_aggressiveness: 0.75,  // 0.5 = moderate, 1.0 = full compensation, 1.5 = very aggressive


    // Debug
    enable_debug: true,

    // Persistent Logging
    enable_persistent_logging: true,
    max_log_entries: 500,       // Keep last 500 log entries
    log_hws_changes: true,      // Log all HWS on/off events
    log_state_changes: true,    // Log all state transitions
    log_daily_summary: true     // Log daily summary at midnight
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
// HELPER FUNCTIONS
// =============================================================================

// --- Local Time Helpers for EST (GMT+10) ---
function getLocalDate(offsetHours = 10) {
    // Returns a Date object adjusted to GMT+10 (EST)
    const now = new Date();
    // Get UTC time in ms, add offset in ms
    const localTime = new Date(now.getTime() + (offsetHours * 60 * 60 * 1000));
    return localTime;
}

function getLocalISOString(offsetHours = 10) {
    // Returns ISO string in GMT+10 (EST)
    const local = getLocalDate(offsetHours);
    return local.toISOString().replace('Z', '+10:00');
}

function getLocalDateString(offsetHours = 10) {
    // Returns YYYY-MM-DD in GMT+10 (EST)
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
        // First request for this transition
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
        // Debounce period satisfied
        global.set(`state_change_request_${stateChangeKey}`, 0); // Reset
        addPersistentLog('DEBOUNCE', `State change approved: ${currentState} → ${targetState}`, {
            transition: stateChangeKey,
            time_waited: Math.round(timeSinceRequest / 1000),
            reason: reason
        });
        return { allowed: true, reason: 'Debounce period satisfied' };
    } else {
        // Still in debounce period
        const remainingTime = Math.round((debounceMs - timeSinceRequest) / 1000);
        return { 
            allowed: false, 
            reason: `Debouncing (${remainingTime}s remaining)` 
        };
    }
}

function clearOtherStateChangeRequests(allowedTransition) {
    // Clear any other pending state change requests when one is approved
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
    // Get current date in YYYY-MM-DD format (local EST)
    const currentDate = getLocalDateString();

    // Always clear the in-memory version to avoid confusion
    global.set('export_history_30days', undefined);

    // Get existing history (use file storage for persistence only)
    let exportHistory = global.get('export_history_30days', 'file') || [];

    // Only update if today's entry does not exist (prevents multiple updates per day)
    const todayIndex = exportHistory.findIndex(entry => entry.date === currentDate);
    if (todayIndex >= 0) {
        // Already updated today, do not update again
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

    // Add new entry for today
    exportHistory.push(todayEntry);

    // Keep only the last 30 days
    exportHistory = exportHistory
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .slice(-30);

    // Save back to persistent storage (file only)
    global.set('export_history_30days', exportHistory, 'file');

    if (CONFIG.enable_debug) {
        node.log(`Updated export history: ${exportHistory.length} days, today: ${dailyExport.toFixed(1)} kWh`);
    }

    return exportHistory;
}

function getCurrentMonthTarget() {
    // First try to use existing calculation if available and recent
    const targetCalc = global.get('target_calculation', 'file');
    if (targetCalc && targetCalc.method === "rolling_30day" && targetCalc.adjusted_target) {
        return targetCalc.adjusted_target; // Use adaptive target
    }

    // Calculate adaptive rolling target if not available or outdated
    const exportHistory = global.get('export_history_30days', 'file') || [];
    if (exportHistory.length > 0) {
        // Use up to 30 days, minimum 3 days for reliable calculation
        const daysToUse = Math.min(exportHistory.length, 30);

        if (daysToUse >= 3) { // Need minimum data for adaptive logic
            const recentHistory = exportHistory.slice(-daysToUse);

            // Calculate rolling average (base target)
            const totalExport = recentHistory.reduce((sum, day) => {
                return sum + (day.export || 0);
            }, 0);
            const rollingAverage = totalExport / daysToUse;

            // Get static monthly target for comparison
            const currentMonth = getLocalDate().getMonth() + 1;
            const staticMonthlyTarget = MONTHLY_EXPORT_TARGETS[currentMonth] || 25.0;

            // Calculate adaptive adjustment
            let adjustedTarget;
            const performance = rollingAverage / staticMonthlyTarget; // Performance ratio

            if (performance < 0.9) {
                // Under-performing (< 90% of monthly target) - set target above monthly to catch up
                const shortfall = staticMonthlyTarget - rollingAverage; // How much behind per day
                const catchUpBoost = shortfall * CONFIG.catchup_aggressiveness; // Take % of shortfall and add to monthly target
                adjustedTarget = staticMonthlyTarget + catchUpBoost;
                adjustedTarget = Math.min(adjustedTarget, staticMonthlyTarget * 1.5); // Cap at 150% of monthly
            } else if (performance > 1.1) {
                // Over-performing (> 110% of monthly target) - can reduce target slightly
                const excess = rollingAverage - staticMonthlyTarget; // How much ahead per day
                const coolDownReduction = excess * 0.3; // Take 30% of excess off monthly target
                adjustedTarget = staticMonthlyTarget - coolDownReduction;
                adjustedTarget = Math.max(adjustedTarget, staticMonthlyTarget * 0.8); // Floor at 80% of monthly
            } else {
                // Within normal range (90-110%) - use monthly target
                adjustedTarget = staticMonthlyTarget;
            }

            // Store the calculation for future use (persistent storage)
            const calculatedTarget = {
                base_target: rollingAverage,
                adjusted_target: adjustedTarget,
                static_monthly_target: staticMonthlyTarget,
                performance_ratio: performance,
                method: "rolling_30day",
                rolling_days: daysToUse,
                rolling_export_total: totalExport,
                calculation_date: getLocalISOString(),
                data_points: daysToUse,
                adjustment_reason: performance < 0.9 ? 'under_performing' :
                    performance > 1.1 ? 'over_performing' : 'normal'
            };

            global.set('target_calculation', calculatedTarget, 'file');

            if (CONFIG.enable_debug) {
                node.warn(`Adaptive target: ${adjustedTarget.toFixed(1)} kWh (avg: ${rollingAverage.toFixed(1)}, monthly: ${staticMonthlyTarget.toFixed(1)}, performance: ${(performance * 100).toFixed(1)}%)`);
            }

            return adjustedTarget;
        }
    }

    // Fall back to static monthly table if insufficient history
    const currentMonth = getLocalDate().getMonth() + 1;
    const staticTarget = MONTHLY_EXPORT_TARGETS[currentMonth] || 25.0;

    if (CONFIG.enable_debug) {
        node.warn(`Using static monthly target: ${staticTarget} kWh (insufficient history for adaptive calculation)`);
    }

    return staticTarget;
}

function getExcessGeneration(generation, gridPower) {
    // Calculate excess generation available
    // If grid_power is negative, we're exporting (excess available)
    // If grid_power is positive, we're importing (no excess)
    return gridPower < 0 ? Math.abs(gridPower) : 0;
}

function shouldResetToExportPriority(dailyExport, targetExport, batteryPower) {
    const exportPercentage = (dailyExport / targetExport) * 100;
    const batteryCharging = batteryPower > CONFIG.strong_charging_threshold; // Changed to use strong charging threshold

    return exportPercentage < CONFIG.export_target_percentage && batteryCharging;
}

function isNightTime() {
    const currentHour = getLocalDate().getHours();

    if (CONFIG.night_start_hour > CONFIG.night_end_hour) {
        // Night period crosses midnight (e.g., 20:00 to 06:00)
        return currentHour >= CONFIG.night_start_hour || currentHour < CONFIG.night_end_hour;
    } else {
        // Night period within same day
        return currentHour >= CONFIG.night_start_hour && currentHour < CONFIG.night_end_hour;
    }
}

function validateInputData(inputs) {
    const errors = [];

    // Validate SOC bounds
    if (inputs.batterySoc < CONFIG.min_reasonable_soc || inputs.batterySoc > CONFIG.max_reasonable_soc) {
        errors.push(`Battery SOC ${inputs.batterySoc}% outside reasonable bounds`);
    }

    // Validate power values
    if (Math.abs(inputs.generation) > CONFIG.max_reasonable_power) {
        errors.push(`Generation ${inputs.generation}W outside reasonable bounds`);
    }

    if (Math.abs(inputs.gridPower) > CONFIG.max_reasonable_power) {
        errors.push(`Grid power ${inputs.gridPower}W outside reasonable bounds`);
    }

    if (Math.abs(inputs.batteryPower) > CONFIG.max_reasonable_power) {
        errors.push(`Battery power ${inputs.batteryPower}W outside reasonable bounds`);
    }

    // Validate daily export is reasonable
    if (inputs.dailyExport < 0 || inputs.dailyExport > 200) {
        errors.push(`Daily export ${inputs.dailyExport}kWh outside reasonable bounds`);
    }

    return errors;
}

function initializeStateIfNeeded() {
    // Ensure state persistence across Node-RED restarts
    const currentState = global.get('energy_management_state');
    if (!currentState || !Object.values(STATES).includes(currentState)) {
        global.set('energy_management_state', STATES.EXPORT_PRIORITY);
        if (CONFIG.enable_debug) {
            node.warn('Initialized energy management state to EXPORT_PRIORITY');
        }
        return STATES.EXPORT_PRIORITY;
    }
    return currentState;
}

function addPersistentLog(logType, message, data = {}) {
    if (!CONFIG.enable_persistent_logging) return;

    // Get existing logs
    let logs = global.get('energy_management_logs', 'file') || [];

    // Create log entry
    const logEntry = {
        timestamp: getLocalISOString(),
        type: logType,
        message: message,
        data: data,
        date: getLocalDateString() // For easy daily filtering
    };

    // Add to logs
    logs.push(logEntry);

    // Keep only recent entries
    if (logs.length > CONFIG.max_log_entries) {
        logs = logs.slice(-CONFIG.max_log_entries);
    }

    // Save back to persistent storage
    global.set('energy_management_logs', logs, 'file');

    // Also log to Node-RED console if debug enabled
    if (CONFIG.enable_debug) {
        node.log(`[${logType}] ${message}`);
    }
}

function logHWSEvent(action, reason, hwsStatus, batterySoc, generation) {
    if (!CONFIG.log_hws_changes) return;

    addPersistentLog('HWS_EVENT', `HWS ${action}: ${reason}`, {
        hws_status: hwsStatus,
        battery_soc: batterySoc,
        generation: generation,
        action: action,
        reason: reason
    });
}

function logStateChange(fromState, toState, reason, inputs) {
    if (!CONFIG.log_state_changes) return;

    addPersistentLog('STATE_CHANGE', `${fromState} → ${toState}: ${reason}`, {
        from_state: fromState,
        to_state: toState,
        reason: reason,
        daily_export: inputs.dailyExport,
        target_export: inputs.targetExport,
        battery_soc: inputs.batterySoc,
        generation: inputs.generation,
        battery_power: inputs.batteryPower
    });
}

function logDailySummary(dailyExport, targetExport, inputs) {
    if (!CONFIG.log_daily_summary) return;

    const currentHour = getLocalDate().getHours();
    // Only log summary once around midnight (23:00-01:00)
    if (currentHour >= 23 || currentHour <= 1) {
        const lastSummary = global.get('last_daily_summary_date', 'file') || '';
        const today = getLocalDateString();

        if (lastSummary !== today) {
            addPersistentLog('DAILY_SUMMARY', `Daily Summary: ${dailyExport.toFixed(1)}/${targetExport.toFixed(1)} kWh`, {
                daily_export: dailyExport,
                target_export: targetExport,
                target_achieved: dailyExport >= targetExport,
                battery_soc_end: inputs.batterySoc,
                performance_percent: ((dailyExport / targetExport) * 100).toFixed(1)
            });

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
    // If we're exporting significantly but generation shows low/zero, trust the grid data
    if (currentState === STATES.EXPORT_PRIORITY && gridPower < -CONFIG.significant_export_threshold) {
        // Strong export indicates generation is working, maintain export state regardless of generation sensor
        nextState = currentState;
        stateReason = `Maintaining export state: exporting ${Math.abs(gridPower)}W (generation sensor possibly stale: ${generation}W)`;
        
        addPersistentLog('DATA_PROTECTION', `Generation data suspicious: ${generation}W reported but exporting ${Math.abs(gridPower)}W`, {
            reported_generation: generation,
            grid_power: gridPower,
            battery_power: batteryPower,
            action: 'maintaining_export_state'
        });
        
        return { nextState, stateReason };
    }

    // Check for reset to export priority first (can happen from any state)
    // Priority 1: If export target not reached, we should prioritize export (BUT NOT DURING NIGHT AND ONLY WITH MEANINGFUL SOLAR + STRONG CHARGING)
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
    // Priority 2: Additional reset condition for when significantly below target and battery charging (NOT DURING NIGHT AND WITH STRONG SOLAR OR CHARGING)
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
    // Priority 3: Hysteresis check - if in EXPORT_PRIORITY, check both generation AND battery power before switching away
    else if (currentState === STATES.EXPORT_PRIORITY && !isNightTime() && 
             generation < CONFIG.min_generation_to_stay_export && 
             batteryPower < CONFIG.battery_charging_threshold) {
        const debounceCheck = checkStateChangeDebounce(STATES.SELF_CONSUME, currentState,
            `Generation dropped to ${generation}W below stay threshold (${CONFIG.min_generation_to_stay_export}W) and battery power only ${batteryPower}W`);
        
        if (debounceCheck.allowed) {
            nextState = STATES.SELF_CONSUME;
            stateReason = `Low generation and weak battery charging: ${debounceCheck.reason}`;
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
                    // Evening with low/no solar but battery has charge - self consume instead of grid import
                    nextState = STATES.SELF_CONSUME;
                    stateReason = `Low solar (${generation}W), target not reached, but battery has charge (${batterySoc}%) - self consume to avoid grid import`;
                } else {
                    stateReason = `Export priority: ${dailyExport.toFixed(1)}/${targetExport.toFixed(1)}kWh exported`;
                }
                break;

            case STATES.BATTERY_STORAGE:
                if (batteryFull && excessGeneration > 0) {
                    nextState = STATES.LOAD_MANAGEMENT;
                    stateReason = `Battery full (${batterySoc}%), excess generation ${excessGeneration}W - activating load management`;
                } else if (batteryLow && !batteryCharging) {
                    nextState = STATES.SELF_CONSUME;
                    stateReason = `Battery low (${batterySoc}%) and not charging - switching to self consume`;
                } else if (batteryPower < 0) {
                    // Battery is discharging - this is self consumption, not storage
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
                    // Should turn off HWS and potentially change state
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
                if (batterySoc <= CONFIG.min_soc_threshold) {
                    // Battery protection - switch off ESS mode to prevent over-discharge
                    nextState = STATES.EXPORT_PRIORITY;
                    stateReason = `Battery at min SOC (${batterySoc}%) - disabling ESS mode to protect battery`;
                } else if (batteryCharging && !exportTargetReached) {
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
            battery_power: batteryPower
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
                output.actions.enable_hws = hwsStatus; // Maintain current state
                if (hwsStatus) {
                    addPersistentLog('HWS_STATUS', `HWS remains ON: SOC ${batterySoc}%, Gen ${generation}W`, {
                        hws_status: true,
                        battery_soc: batterySoc,
                        generation: generation,
                        reason: 'maintaining_current_state'
                    });
                }
            }
            break;

        case STATES.SELF_CONSUME:
            output.actions.set_ess_mode = true;  // Keep ESS mode active for self-consumption
            output.actions.grid_setpoint = 0;    // Don't import from grid
            output.actions.inverter_mode = 3;
            break;

        case STATES.SAFE_MODE:
            output.actions.set_ess_mode = false;
            output.actions.inverter_mode = 4; // Inverter off
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
    if (energyManagementEnabled === false) {
        // Module is disabled - return disabled status
        msg.payload = {
            timestamp: getLocalISOString(),
            current_state: 'DISABLED',
            actions: {
                set_ess_mode: false,
                grid_setpoint: null,
                enable_hws: false,
                inverter_mode: 3  // Normal operation
            },
            status: {
                module_enabled: false,
                message: 'Energy management module is disabled'
            }
        };
        return msg;
    }

    // Get input data from global context
    const dailyExport = (global.get('export_daily') || 0) / 1000; // Convert Wh to kWh
    const gridPower = global.get('grid_power') || 0;
    const generation = global.get('generation') || 0;
    const batterySoc = global.get('victron_soc') || 50;
    const batteryPower = global.get('battery_power') || 0;
    const inverterMode = global.get('victron_mode') || 3;

    // Initialize and get current state (with persistence protection)
    const currentState = initializeStateIfNeeded();
    // Get target for current month
    const targetExport = getCurrentMonthTarget();

    // Update daily export history (maintains rolling 30-day history)
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
        node.warn(`Data validation errors: ${validationErrors.join(', ')}`);

        // Return safe mode for invalid data
        msg.payload = {
            timestamp: getLocalISOString(),
            current_state: STATES.SAFE_MODE,
            actions: {
                set_ess_mode: false,
                grid_setpoint: null,
                enable_hws: false,
                inverter_mode: 3  // Keep inverter on but disable ESS
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

    // Log daily summary (once per day around midnight)
    logDailySummary(dailyExport, targetExport, inputs);

    // Generate output
    const output = generateOutput(nextState, inputs, stateReason);

    // Store HWS status for next iteration
    global.set('hws_status', output.actions.enable_hws);

    // Send output
    msg.payload = output;
    return msg;

} catch (error) {
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