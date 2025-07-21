# Energy Management System for Solar + Battery + Victron ESS

## Overview

This Node-RED based energy management system optimizes household solar energy usage by intelligently managing export targets, battery charging/discharging, and hot water system load management. The system uses an adaptive state machine that learns from historical performance to automatically adjust daily export targets and control a Victron Energy ESS (Energy Storage System).

## System Goals

### Primary Objectives
1. **Meet Monthly Export Targets**: Achieve consistent monthly solar export totals that match seasonal expectations
2. **Optimize Battery Usage**: Maximize self-consumption while protecting battery from over-discharge
3. **Load Management**: Use hot water system as controllable load to consume excess solar
4. **Adaptive Learning**: Automatically adjust targets based on recent performance and weather patterns

### Key Benefits
- **Predictable monthly export totals** regardless of daily weather variation
- **Intelligent battery protection** with context-aware state management
- **Smooth month-to-month transitions** using rolling 30-day windows
- **Anti-oscillation logic** to prevent rapid state switching during variable conditions

## Architecture

### Core Components

```
┌─────────────────┐     ┌──────────────────┐    ┌─────────────────┐
│   Global Data   │───▶│ Energy Mgmt Node │───▶│  Control Logic  │
│   (Sensors)     │     │  (State Machine) │    │   (ESS/HWS)     │
└─────────────────┘     └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │ Persistent Data │
                       │ (History/Logs)  │
                       └─────────────────┘
```

### State Machine Architecture

The system operates as a finite state machine with 5 primary states:

1. **EXPORT_PRIORITY**: Normal solar export to meet daily targets
2. **BATTERY_STORAGE**: Target reached, store excess in battery (ESS mode active)
3. **LOAD_MANAGEMENT**: Battery full, activate hot water system load
4. **SELF_CONSUME**: Evening/night battery discharge for house loads
5. **SAFE_MODE**: Error handling and fallback mode

## System States Detailed

### EXPORT_PRIORITY
**Purpose**: Normal daytime operation to meet export targets
- **ESS Mode**: OFF (allow normal grid export)
- **Grid Setpoint**: NULL (normal operation)
- **Conditions**: Solar available, daily target not reached
- **Transitions To**: BATTERY_STORAGE (target reached), SELF_CONSUME (evening/low battery)

### BATTERY_STORAGE  
**Purpose**: Store excess solar after meeting export targets
- **ESS Mode**: ON (grid setpoint = 0W)
- **Grid Setpoint**: 0W (force battery charging)
- **Conditions**: Export target reached, battery not full
- **Transitions To**: LOAD_MANAGEMENT (battery full), SELF_CONSUME (battery discharging)

### LOAD_MANAGEMENT
**Purpose**: Use hot water system when battery is full
- **ESS Mode**: ON (grid setpoint = 0W) 
- **HWS Control**: Active (3kW load)
- **Conditions**: Battery ≥99% SOC, excess generation available
- **Transitions To**: BATTERY_STORAGE (SOC drops/generation drops)

### SELF_CONSUME
**Purpose**: Use battery power for house loads
- **ESS Mode**: ON (grid setpoint = 0W)
- **Grid Setpoint**: 0W (prevent grid import)
- **Conditions**: Evening, low solar, battery has charge
- **Transitions To**: EXPORT_PRIORITY (morning solar), BATTERY_STORAGE (charging + target reached)

### SAFE_MODE
**Purpose**: Error handling and protection
- **ESS Mode**: OFF
- **Inverter Mode**: 4 (OFF) or 3 (ON with safety)
- **Conditions**: Data validation errors, system faults

## Adaptive Target System

### Rolling 30-Day Window
The system maintains a continuous 30-day rolling window of export history that spans month boundaries:

```javascript
// Example month transition (July → August)
July 31:  [30 days July data] vs July target (23.5 kWh)
Aug 1:    [29 days July + 1 day Aug] vs August target (24.3 kWh)  
Aug 15:   [16 days July + 14 days Aug] vs August target
Aug 31:   [30 days August data] vs August target
```

### Performance-Based Adjustments

#### Under-Performing (< 90% of monthly target)
- **Detection**: Rolling average < 90% of current month's target
- **Action**: Increase daily target above monthly target
- **Formula**: `adjusted_target = monthly_target + (shortfall × 0.5)`
- **Cap**: Maximum 150% of monthly target

#### Over-Performing (> 110% of monthly target)  
- **Detection**: Rolling average > 110% of current month's target
- **Action**: Decrease daily target below monthly target
- **Formula**: `adjusted_target = monthly_target - (excess × 0.3)`
- **Floor**: Minimum 80% of monthly target

#### Normal Performance (90-110%)
- **Action**: Use static monthly target
- **Result**: Stable, predictable targets

### Monthly Targets (Configurable)
```javascript
const MONTHLY_EXPORT_TARGETS = {
    1: 25.5,   // January (kWh/day)
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
```

## Anti-Oscillation Logic

### Hysteresis System
Prevents rapid state switching during variable solar conditions:
- **Enter Export Mode**: Requires 500W+ generation OR 1000W+ battery charging
- **Stay in Export Mode**: Only needs 300W+ generation AND 50W+ battery charging
- **200W buffer zone** prevents oscillation around threshold

### Debouncing System  
Requires conditions to persist for 5 minutes before state changes:
```javascript
// Example: Intermittent solar day
09:15 - Solar: 600W → "Export priority requested but Debouncing (5min required)"
09:16 - Solar: 400W → Request cancelled (below threshold)
09:17 - Solar: 650W → "Export priority requested but Debouncing (4min required)"  
09:20 - Solar: 580W → "State change approved: SELF_CONSUME → EXPORT_PRIORITY"
```

### Data Protection
Handles stale generation sensor data:
- **Detection**: Exporting >2kW but generation <500W (suspicious)
- **Action**: Maintain current state, trust grid meter over generation sensor
- **Logging**: Records data inconsistencies for troubleshooting

## Battery Protection System

### Multi-Level Protection
1. **Priority Override**: When SOC ≤ 25% and battery discharging
2. **Target Awareness**: Different actions based on export target status
3. **Discharge Prevention**: Only activates when battery actually discharging

### Protection Logic
```javascript
// Target not reached + low SOC + discharging
if (SOC ≤ 25% && battery_power < 0 && !target_reached) {
    → Force EXPORT_PRIORITY (disable ESS, allow grid import)
}

// Target reached + low SOC + discharging  
if (SOC ≤ 25% && battery_power < 0 && target_reached) {
    → Force EXPORT_PRIORITY (disable ESS, allow grid import)
}

// Low SOC but charging (normal operation)
if (SOC ≤ 25% && battery_power > 0) {
    → No override (allow normal charging)
}
```

## Node-RED Integration

### Required Global Variables (Input)
```javascript
// Power Data (Watts)
global.generation        // Solar generation (W) - can go stale
global.grid_power       // Grid power (W) - negative = export, positive = import  
global.battery_power    // Battery power (W) - positive = charging, negative = discharging

// Energy Data (Watt-hours)
global.export_daily     // Daily export total (Wh) - resets at midnight

// System Status
global.victron_soc      // Battery state of charge (%)
global.victron_mode     // Inverter mode (3 = on, 4 = off)

// Control Variables  
global.energy_management_enabled  // true/false - master enable/disable
```

### Output Structure
```javascript
{
    "timestamp": "2025-07-20T15:30:00.000+10:00",
    "current_state": "BATTERY_STORAGE",
    "actions": {
        "set_ess_mode": true,           // Enable/disable ESS mode
        "grid_setpoint": 0,             // Grid setpoint (W) - 0 = no import/export
        "enable_hws": false,            // Hot water system on/off
        "inverter_mode": 3              // Victron inverter mode
    },
    "status": {
        "export_target": 25.2,          // Today's export target (kWh)
        "daily_export": 18.5,           // Current daily export (kWh)
        "target_reached": false,        // Whether target achieved
        "battery_soc": 85,              // Battery charge level (%)
        "excess_generation": 2500,      // Available excess power (W)
        "battery_power": 1200           // Current battery power (W)
    },
    "debug": {
        "state_reason": "Battery storage: SOC 85%, storing 1200W",
        "next_check": "2025-07-20T15:35:00.000Z"
    }
}
```

### Flow Architecture
```
[Inject Timer] → [Energy Management] → [ESS Control] → [MQTT Out]
    ↓                     ↓                ↓
[Every 5min]         [State Logic]    [Victron Commands]
                         ↓
                  [Persistent Storage]
```

### MQTT Control Messages
The system generates specific MQTT commands for Victron ESS control:

#### ESS Mode Enable
```javascript
[
    {
        topic: "W/c0619ab7538f/settings/0/Settings/CGwacs/AcPowerSetPoint",
        payload: {"value": 0}
    },
    {
        topic: "W/c0619ab7538f/settings/0/Settings/CGwacs/BatteryLife/State", 
        payload: {"value": 10}
    },
    {
        topic: "W/c0619ab7538f/settings/0/Settings/CGwacs/Hub4Mode",
        payload: {"value": 1}
    },
    {
        topic: "W/c0619ab7538f/vebus/276/Mode",
        payload: {"value": 3}
    }
]
```

## Persistent Data Storage

### Export History (`export_history_30days`)
```javascript
[
    {
        "date": "2025-07-20",
        "export": 24.5,                    // kWh exported that day
        "target": 25.2,                    // Target for that day
        "timestamp": "2025-07-20T23:59:59+10:00"
    }
    // ... up to 30 days
]
```

### Target Calculation (`target_calculation`)
```javascript
{
    "base_target": 20.1,                   // Rolling average (kWh/day)
    "adjusted_target": 25.2,               // Adaptive target (kWh/day)
    "static_monthly_target": 23.5,         // Current month reference
    "performance_ratio": 0.85,             // Performance vs monthly target
    "method": "rolling_30day",
    "rolling_days": 20,                    // Days of data used
    "rolling_export_total": 402.0,         // Total kWh over rolling period
    "calculation_date": "2025-07-20T15:30:00+10:00",
    "data_points": 20,
    "adjustment_reason": "under_performing",
    "shortfall_per_day": 3.4,              // kWh behind per day
    "catchup_boost": 1.7,                  // kWh boost applied
    "mixed_month_data": {
        "has_mixed_months": true,
        "months_included": [7, 8],
        "month_count": 2
    }
}
```

### System Logs (`energy_management_logs`)
```javascript
[
    {
        "timestamp": "2025-07-20T15:30:00+10:00",
        "type": "STATE_CHANGE",
        "message": "EXPORT_PRIORITY → BATTERY_STORAGE: Export target 25.2kWh reached",
        "data": {
            "from_state": "EXPORT_PRIORITY",
            "to_state": "BATTERY_STORAGE", 
            "reason": "Export target reached",
            "daily_export": 25.3,
            "battery_soc": 75
        },
        "date": "2025-07-20"
    }
]
```

### Log Types
- **STATE_CHANGE**: All state transitions with reasons
- **HWS_EVENT**: Hot water system on/off events  
- **DEBOUNCE**: State change requests and approvals
- **DATA_PROTECTION**: Stale generation data detection
- **BATTERY_PROTECTION**: Low SOC protection activations
- **DAILY_SUMMARY**: End-of-day performance summaries

## Configuration Parameters

### Core Thresholds
```javascript
const CONFIG = {
    // Battery SOC Management
    max_soc_threshold: 99,                    // % - Switch to load management
    min_soc_threshold: 25,                    // % - Battery protection trigger
    
    // Generation Thresholds (Anti-oscillation)
    min_generation_for_export: 500,          // W - Enter export mode
    min_generation_to_stay_export: 300,      // W - Stay in export mode (hysteresis)
    strong_charging_threshold: 1000,         // W - Strong battery charging indicator
    battery_charging_threshold: 50,          // W - Minimum "charging" detection
    
    // Export Target Logic
    export_target_percentage: 40,            // % - Reset threshold for priority 2
    evening_self_consume_soc_threshold: 30,  // % - Evening self-consume minimum SOC
    
    // Time-based Logic
    night_start_hour: 20,                    // Hour - Night period start (24h format)
    night_end_hour: 6,                       // Hour - Night period end (24h format)
    
    // Hot Water System
    hws_power_rating: 3000,                  // W - HWS power consumption
    hws_soc_drop_threshold: 2,               // % - SOC drop to turn off HWS
    hws_generation_drop_threshold: 1000,     // W - Generation drop to turn off HWS
    hws_cooldown_period: 30,                 // minutes - Prevent rapid cycling
    
    // Anti-oscillation
    state_change_debounce_time: 5,           // minutes - State change persistence requirement
    
    // Data Protection
    significant_export_threshold: 2000,      // W - Threshold for stale data detection
    
    // Adaptive Targets
    catchup_aggressiveness: 0.5,             // Multiplier for catch-up boost (0.5 = 50%)
    
    // Logging
    enable_persistent_logging: true,
    max_log_entries: 500,
    log_hws_changes: true,
    log_state_changes: true,
    log_daily_summary: true
};
```

## Timezone Handling

The system uses local time (EST/GMT+10) throughout:

```javascript
function getLocalDate(offsetHours = 10) {
    const now = new Date();
    return new Date(now.getTime() + (offsetHours * 60 * 60 * 1000));
}

function getLocalISOString(offsetHours = 10) {
    const local = getLocalDate(offsetHours);
    return local.toISOString().replace('Z', '+10:00');
}
```

All timestamps, date calculations, and midnight resets use local time to ensure accurate daily boundaries and month transitions.

## Installation and Setup

### 1. Node-RED Function Node Setup
1. Create a Function Node in Node-RED
2. Copy the complete energy management code into the Function tab
3. Configure node outputs: 1 output
4. Set node name: "Energy Management System"

### 2. Input Data Flow
```
[Victron MQTT] → [Global Variables] → [Energy Management] 
```
Ensure all required global variables are populated from your Victron system.

### 3. Output Processing
```
[Energy Management] → [ESS Control Function] → [MQTT Out] → [Victron System]
```

### 4. Trigger Setup  
```
[Inject Node] → [Energy Management]
  ↓
[Every 5 minutes]
```

### 5. Midnight Reset (Separate Flow)
Create a separate daily trigger to update export history:
```
[Inject: Daily 00:01] → [Midnight Reset Function] → [Update History]
```

## Troubleshooting

### Common Issues

#### Rapid State Switching
- **Symptom**: States changing every few minutes
- **Cause**: Insufficient debouncing or hysteresis
- **Solution**: Increase `state_change_debounce_time` or adjust generation thresholds

#### Battery Over-discharge
- **Symptom**: Battery SOC dropping below 25%
- **Cause**: Battery protection not triggering
- **Solution**: Check battery power readings, verify protection logic

#### Unrealistic Targets
- **Symptom**: Daily targets too high/low
- **Cause**: Insufficient history or incorrect monthly targets
- **Solution**: Verify export history, adjust `catchup_aggressiveness`

#### Stale Generation Data
- **Symptom**: "DATA_PROTECTION" logs appearing frequently
- **Cause**: Generation sensor issues
- **Solution**: Check sensor connections, verify threshold settings

### Debug Tools

#### View Current Target Calculation
```javascript
const calc = global.get('target_calculation', 'file');
msg.payload = calc;
return msg;
```

#### View Export History
```javascript
const history = global.get('export_history_30days', 'file');
msg.payload = history.slice(-7); // Last 7 days
return msg;
```

#### View Recent Logs
```javascript
const logs = global.get('energy_management_logs', 'file') || [];
const recent = logs.filter(log => 
    new Date(log.timestamp) > new Date(Date.now() - 24*60*60*1000)
);
msg.payload = recent;
return msg;
```

#### Force Target Recalculation
```javascript
global.set('target_calculation', undefined, 'file');
msg.payload = "Target calculation cleared - will recalculate";
return msg;
```

## Future Development

### Potential Enhancements

1. **Weather Integration**
   - Use weather forecasts to adjust targets
   - Predict solar generation for better planning

2. **Time-of-Use Tariffs**
   - Optimize export timing for better feed-in rates
   - Adjust battery discharge timing for peak avoidance

3. **Multiple Load Management**
   - Support for additional controllable loads
   - Priority-based load scheduling

4. **Machine Learning**
   - Predict optimal targets based on historical patterns
   - Seasonal adaptation beyond simple monthly targets

5. **Advanced Battery Protection**
   - Temperature-based SOC limits
   - Battery health monitoring integration

6. **Grid Services**
   - Virtual power plant participation
   - Frequency regulation services

### Development Notes for AI Models

When continuing development:

1. **Maintain backward compatibility** with existing data structures
2. **Test month rollover logic** thoroughly with edge cases  
3. **Consider battery chemistry differences** for SOC thresholds
4. **Validate timezone handling** for different locations
5. **Preserve anti-oscillation logic** - it's critical for stability
6. **Add comprehensive unit tests** for state machine transitions
7. **Document any new configuration parameters** clearly
8. **Consider fail-safe modes** for new features

The system architecture is designed to be modular and extensible while maintaining robust core functionality for solar energy optimization.

## Version History

- **v1.0**: Initial state machine implementation
- **v1.1**: Added adaptive target system  
- **v1.2**: Implemented anti-oscillation logic (hysteresis + debouncing)
- **v1.3**: Enhanced battery protection with discharge detection
- **v1.4**: Added month rollover continuity and mixed-month handling
- **v1.5**: Implemented stale data protection and comprehensive logging

## License

This system is designed for residential solar energy optimization. Modify configuration parameters according to your specific hardware and energy requirements.
