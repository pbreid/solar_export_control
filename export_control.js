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
    export_target_percentage: 10,  // % - If daily export < this % of target AND battery charging
    battery_charging_threshold: 50, // W - Minimum power to consider "charging" (noise filter)
    min_generation_for_export: 500, // W - Minimum solar generation needed to switch to export mode

    // Safety & Data Validation
    data_freshness_limit: 5,    // minutes - Max age of data before fallback
    max_reasonable_soc: 105,    // % - Upper bound for SOC validation
    min_reasonable_soc: -5,     // % - Lower bound for SOC validation
    max_reasonable_power: 50000, // W - Upper bound for power validation

    // Time-based logic
    night_start_hour: 20,       // Hour (24h format) when night period starts
    night_end_hour: 6,          // Hour (24h format) when night period ends

    // Debug
    enable_debug: true
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

function updateDailyExportHistory(dailyExport, targetExport) {
    // Get current date in YYYY-MM-DD format
    const currentDate = new Date().toISOString().split('T')[0];

    // Get existing history (use file storage for persistence)
    let exportHistory = global.get('export_history_30days', 'file') || [];

    // Check if we already have an entry for today
    const todayIndex = exportHistory.findIndex(entry => entry.date === currentDate);

    const todayEntry = {
        date: currentDate,
        export: dailyExport,
        target: targetExport,
        timestamp: new Date().toISOString()
    };

    if (todayIndex >= 0) {
        // Update existing entry for today
        exportHistory[todayIndex] = todayEntry;
    } else {
        // Add new entry for today
        exportHistory.push(todayEntry);
    }

    // Keep only the last 30 days
    exportHistory = exportHistory
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .slice(-30);

    // Save back to persistent storage
    global.set('export_history_30days', exportHistory, 'file');

    if (CONFIG.enable_debug) {
        node.log(`Updated export history: ${exportHistory.length} days, today: ${dailyExport.toFixed(1)} kWh`);
    }

    return exportHistory;
}

function getCurrentMonthTarget() {
    // First try to use existing calculation if available and recent
    const targetCalc = global.get('target_calculation');
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
            const currentMonth = new Date().getMonth() + 1;
            const staticMonthlyTarget = MONTHLY_EXPORT_TARGETS[currentMonth] || 25.0;

            // Calculate adaptive adjustment
            let adjustedTarget;
            const performance = rollingAverage / staticMonthlyTarget; // Performance ratio

            if (performance < 0.9) {
                // Under-performing (< 90% of monthly target) - increase target to catch up
                const catchUpFactor = 1.1 + (0.9 - performance); // 10% base + additional based on shortfall
                adjustedTarget = rollingAverage * catchUpFactor;
                adjustedTarget = Math.min(adjustedTarget, staticMonthlyTarget * 1.3); // Cap at 130% of monthly
            } else if (performance > 1.1) {
                // Over-performing (> 110% of monthly target) - reduce target to balance
                const coolDownFactor = 0.95 - (performance - 1.1) * 0.1; // Reduce based on excess
                adjustedTarget = rollingAverage * Math.max(coolDownFactor, 0.8); // Floor at 80% of average
            } else {
                // Within normal range (90-110%) - use rolling average
                adjustedTarget = rollingAverage;
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
                calculation_date: new Date().toISOString(),
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
    const currentMonth = new Date().getMonth() + 1;
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
    const batteryCharging = batteryPower > CONFIG.battery_charging_threshold;

    return exportPercentage < CONFIG.export_target_percentage && batteryCharging;
}

function isNightTime() {
    const currentHour = new Date().getHours();

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

    // Check for reset to export priority first (can happen from any state)
    // Priority 1: If export target not reached, we should prioritize export (BUT NOT DURING NIGHT AND ONLY WITH MEANINGFUL SOLAR)
    if (!exportTargetReached && !isNightTime() && generation >= CONFIG.min_generation_for_export) {
        if (currentState !== STATES.EXPORT_PRIORITY) {
            nextState = STATES.EXPORT_PRIORITY;
            stateReason = `Reset to export priority: Daily export ${dailyExport.toFixed(1)}kWh has not reached target ${targetExport.toFixed(1)}kWh with ${generation}W generation available`;
        }
    }
    // Priority 2: Additional reset condition for when significantly below target and battery charging (NOT DURING NIGHT AND WITH SOLAR)
    else if (shouldResetToExportPriority(dailyExport, targetExport, batteryPower) && !isNightTime() && generation >= CONFIG.min_generation_for_export) {
        nextState = STATES.EXPORT_PRIORITY;
        stateReason = `Reset to export priority: Daily export ${dailyExport.toFixed(1)}kWh < ${CONFIG.export_target_percentage}% of target ${targetExport.toFixed(1)}kWh and battery charging >${CONFIG.battery_charging_threshold}W with ${generation}W generation`;
    }
    else {
        switch (currentState) {
            case STATES.EXPORT_PRIORITY:
                if (exportTargetReached) {
                    nextState = STATES.BATTERY_STORAGE;
                    stateReason = `Export target ${targetExport.toFixed(1)}kWh reached, switching to battery storage`;
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
        timestamp: new Date().toISOString(),
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
            } else if (hwsStatus && (socDropped || generationDropped)) {
                output.actions.enable_hws = false;
                global.set('hws_last_off_time', Date.now());
            } else {
                output.actions.enable_hws = hwsStatus; // Maintain current state
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
            timestamp: new Date().toISOString(),
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
            timestamp: new Date().toISOString(),
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
        if (CONFIG.enable_debug) {
            node.warn(`State change: ${currentState} → ${nextState}`);
        }
    }

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
        timestamp: new Date().toISOString(),
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
