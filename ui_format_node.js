// Simple Solution: Update logs less frequently than main dashboard
// Place this in your UI function node

try {
    // Get all the energy management data
    const targetCalc = global.get('target_calculation', 'file') || {};
    var currentState = global.get('energy_management_state') || 'UNKNOWN';

    var currentEnabledState = global.get('energy_management_enabled') || false;
    if (!currentEnabledState) currentState = 'DISABLED';

    
    const dailyExport = (global.get('export_daily') || 0) / 1000;
    const batterySoc = global.get('victron_soc') || 0;
    const generation = global.get('generation') || 0;
    const gridPower = global.get('grid_power') || 0;
    const batteryPower = global.get('battery_power') || 0;
    const exportHistory = global.get('export_history_30days', 'file') || [];
    
    // Check if we should update logs (every 10 seconds instead of every second)
    const now = Date.now();
    const lastLogUpdate = global.get('last_log_update_time') || 0;
    const logUpdateInterval = 10000; // 10 seconds
    const shouldUpdateLogs = (now - lastLogUpdate) > logUpdateInterval;
    
    let energyLogs = [];
    if (shouldUpdateLogs) {
        // Update logs from file storage
        energyLogs = global.get('energy_management_logs', 'file') || [];
        global.set('last_log_update_time', now);
        global.set('cached_logs', energyLogs); // Cache the logs
    } else {
        // Use cached logs
        energyLogs = global.get('cached_logs') || [];
    }

    // Helper functions (same as before)
    function formatNumber(num, decimals = 1) {
        if (typeof num !== 'number') return '0.0';
        return Math.abs(num).toFixed(decimals);
    }
    
    function formatPercent(num, decimals = 1) {
        return typeof num === 'number' ? (num * 100).toFixed(decimals) + '%' : '0.0%';
    }
    
    function getStateColor(state) {
        const colors = {
            'EXPORT_PRIORITY': '#4CAF50',
            'BATTERY_STORAGE': '#2196F3',
            'LOAD_MANAGEMENT': '#FF9800',
            'SELF_CONSUME': '#9C27B0',
            'SAFE_MODE': '#F44336',
            'DISABLED': '#757575'
        };
        return colors[state] || '#757575';
    }
    
    function getStateDescription(state) {
        switch (state) {
            case 'EXPORT_PRIORITY': return 'Export Priority';
            case 'BATTERY_STORAGE': return 'Battery Storage';
            case 'LOAD_MANAGEMENT': return 'Load Management';
            case 'SELF_CONSUME': return 'Self Consumption';
            case 'SAFE_MODE': return 'Safe Mode';
            case 'DISABLED': return 'System Disabled';
            default: return 'Unknown State';
        }
    }

    function getPerformanceColor(ratio) {
        if (arguments.length === 2) {
            const export_val = arguments[0];
            const target_val = arguments[1];
            ratio = export_val / target_val;
        }
        
        if (ratio >= 1.1) return '#F44336';
        if (ratio >= 1.05) return '#FF9800';
        if (ratio >= 1.0) return '#4CAF50';
        if (ratio >= 0.9) return '#8BC34A';
        if (ratio >= 0.8) return '#FF9800';
        return '#F44336';
    }

    function getPerformanceIcon(export_val, target_val) {
        const ratio = export_val / target_val;
        if (ratio >= 1.1) return '⬆️';
        else if (ratio >= 1.05) return '↗️';
        else if (ratio >= 0.95) return '✅';
        else if (ratio >= 0.8) return '↘️';
        else return '⬇️';
    }

    function getLogTypeColor(logType) {
        const colors = {
            'STATE_CHANGE': '#2196F3',
            'BATTERY_PROTECTION': '#F44336',
            'HWS_EVENT': '#FF9800',
            'DEBOUNCE': '#9C27B0',
            'DATA_PROTECTION': '#795548',
            'DAILY_SUMMARY': '#4CAF50',
            'PERFORMANCE_ALERT': '#E91E63',
            'SYSTEM_INFO': '#607D8B',
            'SYSTEM': '#607D8B',
            'ERROR': '#F44336',
            'WARNING': '#FF9800'
        };
        return colors[logType] || '#607D8B';
    }

    function getLogTypeIcon(logType) {
        const icons = {
            'STATE_CHANGE': '🔄',
            'BATTERY_PROTECTION': '🛡️',
            'HWS_EVENT': '🚿',
            'DEBOUNCE': '⏱️',
            'DATA_PROTECTION': '🔒',
            'DAILY_SUMMARY': '📊',
            'PERFORMANCE_ALERT': '⚡',
            'SYSTEM_INFO': 'ℹ️',
            'SYSTEM': '⚙️',
            'ERROR': '❌',
            'WARNING': '⚠️'
        };
        return icons[logType] || 'ℹ️';
    }

    function formatLogTime(timestamp) {
        try {
            const date = new Date(timestamp);
            return date.toLocaleString('en-AU', {
                timeZone: 'Australia/Brisbane',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            return timestamp;
        }
    }

    function truncateLogMessage(message, maxLength = 180) {
        if (message.length <= maxLength) return message;
        return message.substring(0, maxLength) + '...';
    }
    
    // Calculate current month info
    const currentMonth = new Date().getMonth() + 1;
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const dayOfMonth = new Date().getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    
    // Process logs - get last 5 entries, sorted by time DESC
    const recentLogs = energyLogs
        .slice(-5)
        .reverse()
        .map(log => ({
            id: log.id || (Date.now() + Math.random()),
            timestamp: formatLogTime(log.timestamp),
            type: log.type,
            message: truncateLogMessage(log.message),
            full_message: log.message,
            color: getLogTypeColor(log.type),
            icon: getLogTypeIcon(log.type),
            priority: log.priority || 'normal',
            data: log.data || {}
        }));
    
    // Build the dashboard data
    const dashboardData = {
        status: {
            current_state: currentState,
            state_color: getStateColor(currentState),
            state_description: getStateDescription(currentState),
            timestamp: new Date().toLocaleString('en-AU', {
                timeZone: 'Australia/Brisbane',
                year: 'numeric',
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }),
            logs_updated: shouldUpdateLogs
        },
        
        daily: {
            export_today: formatNumber(dailyExport),
            target_today: formatNumber(targetCalc.adjusted_target || 0),
            target_reached: dailyExport >= (targetCalc.adjusted_target || 0),
            progress_percent: Math.min(100, (dailyExport / (targetCalc.adjusted_target || 1)) * 100).toFixed(1),
            progress_color: dailyExport >= (targetCalc.adjusted_target || 0) ? '#4CAF50' : '#2196F3'
        },
        
        system: {
            battery_soc: formatNumber(batterySoc, 0),
            battery_power: formatNumber(batteryPower, 0),
            battery_status: batteryPower >= 50 ? 'Charging' : batteryPower <= -50 ? 'Discharging' : 'Idle',
            battery_status_color: batteryPower >= 50 ? '#4CAF50' : batteryPower <= -50 ? '#F44336' : '#757575',
            battery_color: batterySoc >= 75 ? '#4CAF50' : batterySoc >= 50 ? '#8BC34A' : batterySoc >= 25 ? '#FF9800' : '#F44336',
            generation: formatNumber(generation, 0),
            grid_power: formatNumber(gridPower, 0),
            grid_status: gridPower < -200 ? 'Exporting' : gridPower > 200 ? 'Importing' : 'Balanced',
            grid_color: gridPower < -200 ? '#4CAF50' : gridPower > 200 ? '#FF9800' : '#757575'
        },
        
        monthly: {
            performance_ratio: formatPercent(targetCalc.performance_ratio || 0),
            performance_color: getPerformanceColor(targetCalc.performance_ratio || 0),
            rolling_days: targetCalc.rolling_days || 0,
            rolling_total: formatNumber(targetCalc.rolling_export_total || 0),
            monthly_target: formatNumber(targetCalc.monthly_export_target || 0),
            monthly_progress: targetCalc.monthly_export_target ? 
                Math.min(100, (targetCalc.rolling_export_total / targetCalc.monthly_export_target) * 100).toFixed(1) : '0.0',
            adjustment_reason: targetCalc.adjustment_reason || 'normal',
            days_in_month: daysInMonth,
            days_remaining: daysRemaining
        },
        
        catchup: targetCalc.adjustment_reason === 'under_performing' ? {
            total_deficit: formatNumber(targetCalc.total_deficit || 0),
            catchup_per_day: formatNumber(targetCalc.catchup_per_day || 0),
            catchup_days: targetCalc.catchup_days_used || 5,
            shortfall_per_day: formatNumber(targetCalc.shortfall_per_day || 0)
        } : null,
        
        over_performance: targetCalc.adjustment_reason === 'over_performing' && targetCalc.performance_ratio >= 1.1 ? {
            performance_ratio: targetCalc.performance_ratio,
            excess_per_day: formatNumber(targetCalc.excess_per_day || 0),
            total_excess: formatNumber((targetCalc.rolling_export_total || 0) - (targetCalc.static_monthly_target * (targetCalc.rolling_days || 1))),
            recommended_reduction: formatNumber((targetCalc.excess_per_day || 0) * 0.8)
        } : null,
        
        recent_history: exportHistory.slice(-7).map(day => {
            const exportVal = parseFloat(day.export) || 0;
            const targetVal = parseFloat(day.target) || 1;
            const performanceRatio = exportVal / targetVal;
            
            return {
                date: new Date(day.date).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' }),
                export: formatNumber(day.export),
                target: formatNumber(day.target),
                achieved: day.export >= day.target,
                achievement_color: getPerformanceColor(exportVal, targetVal),
                performance_icon: getPerformanceIcon(exportVal, targetVal),
                performance_ratio: (performanceRatio * 100).toFixed(1) + '%'
            };
        }),
        
        logs: {
            recent_count: recentLogs.length,
            total_count: energyLogs.length,
            entries: recentLogs,
            last_update: shouldUpdateLogs ? 'Just now' : 'Cached',
            next_update: Math.ceil((logUpdateInterval - (now - lastLogUpdate)) / 1000)
        }
    };
    
    // Create HTML with click-to-expand functionality that works
    const html = `
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        .energy-dashboard {
            background: #2c3e50;
            color: white;
            padding: 15px;
            border-radius: 10px;
            font-family: Arial, sans-serif;
            width: 100%;
            max-width: 100%;
            box-sizing: border-box;
            margin: 0;
        }
        
        * { box-sizing: border-box; }
        
        .section-card {
            background: #34495e;
            border-radius: 6px;
            margin-bottom: 10px;
            border: 1px solid #4a5f7a;
            width: 100%;
        }
        
        .section-header {
            background: #4a5f7a;
            padding: 8px 12px;
            border-radius: 6px 6px 0 0;
            font-weight: bold;
            font-size: 0.9rem;
        }
        
        .metric-grid {
            display: grid;
            gap: 10px;
            margin-bottom: 10px;
            width: 100%;
        }
        
        .metric-grid-3 { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
        .metric-grid-2 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
        .metric-grid-4 { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
        .metric-grid-7 { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
        
        .metric-card {
            background: #2c3e50;
            border-radius: 4px;
            padding: 10px 8px;
            text-align: center;
            border: 1px solid #4a5f7a;
            min-height: 80px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }
        
        .metric-value {
            font-size: 1.3rem;
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .metric-label {
            font-size: 0.75rem;
            color: #bdc3c7;
            margin-bottom: 2px;
        }
        
        .metric-sublabel {
            font-size: 0.65rem;
            color: #95a5a6;
        }
        
        .progress-bar-container {
            width: 100%;
            height: 8px;
            background: #2c3e50;
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        
        .progress-bar-fill {
            height: 100%;
            background: #27ae60;
            transition: width 0.3s ease;
        }
        
        .header-container {
            text-align: center;
            margin-bottom: 15px;
            width: 100%;
        }
        
        .header-container h1 {
            font-size: 1.4rem !important;
            font-weight: bold;
            margin-bottom: 8px !important;
            color: #ecf0f1;
        }
        
        .state-badge {
            display: inline-block;
            padding: 5px 12px;
            border-radius: 15px;
            font-weight: bold;
            font-size: 0.9rem;
            margin: 5px 0;
        }
        
        .timestamp {
            margin-top: 8px;
            margin-bottom: 0;
            color: #bdc3c7;
        }
        
        .log-container {
            max-height: 350px;
            overflow-y: auto;
            padding: 10px;
        }
        
        .log-entry {
            background: #2c3e50;
            border-radius: 4px;
            padding: 8px 10px;
            margin-bottom: 6px;
            border-left: 3px solid;
            font-size: 0.8rem;
            position: relative;
        }
        
        .log-entry.expandable {
            cursor: pointer;
            transition: background-color 0.2s;
        }
        
        .log-entry.expandable:hover {
            background: #34495e;
        }
        
        .log-entry.priority-critical {
            box-shadow: 0 0 3px rgba(231, 76, 60, 0.5);
        }
        
        .log-entry.priority-high {
            border-left-width: 4px;
        }
        
        .log-entry.priority-low {
            opacity: 0.7;
        }
        
        .log-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }
        
        .log-type-badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 0.7rem;
            font-weight: bold;
            color: white;
        }
        
        .log-timestamp {
            font-size: 0.65rem;
            color: #bdc3c7;
        }
        
        .log-message {
            color: #ecf0f1;
            line-height: 1.5;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }
        
        .log-details {
            background: #1a252f;
            padding: 8px;
            margin-top: 6px;
            border-radius: 3px;
            font-size: 0.7rem;
            color: #bdc3c7;
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease;
            display: none;
        }
        
        .log-details.expanded {
            max-height: 200px;
            overflow-y: auto;
        }
        
        .log-summary {
            text-align: center;
            padding: 10px;
            color: #bdc3c7;
            font-size: 0.8rem;
            border-top: 1px solid #4a5f7a;
            margin-top: 10px;
        }
        
        .update-indicator {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 0.7rem;
            margin-left: 10px;
        }
        
        .update-indicator.fresh {
            background: #27ae60;
            color: white;
        }
        
        .update-indicator.cached {
            background: #f39c12;
            color: white;
        }
        
        /* Mobile responsive */
        @media (max-width: 600px) {
            .energy-dashboard {
                padding: 8px;
            }
            
            .metric-card {
                min-height: 60px;
                padding: 6px 4px;
            }
            
            .metric-value {
                font-size: 1rem;
            }
            
            .header-container h1 {
                font-size: 1.1rem !important;
            }
            
            .log-container {
                max-height: 250px;
            }
        }
    </style>
    
    <div class="energy-dashboard">
        <!-- Header -->
        <div class="header-container">
            <h1>⚡ Energy Management System</h1>
            <div class="state-badge" style="background-color: ${dashboardData.status.state_color};">
                ${dashboardData.status.state_description}
            </div>
            <p class="timestamp">
                🕐 ${dashboardData.status.timestamp}
            </p>
        </div>

        <!-- Today's Performance -->
        <div class="section-card">
            <div class="section-header">📊 Today's Performance</div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-3">
                    <div class="metric-card">
                        <div class="metric-value" style="color: #27ae60;">${dashboardData.daily.export_today}</div>
                        <div class="metric-label">kWh Exported</div>
                        <div class="metric-sublabel">📈 Daily Export</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: #3498db;">${dashboardData.daily.target_today}</div>
                        <div class="metric-label">Daily Target</div>
                        <div class="metric-sublabel">🎯 Target Goal</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.daily.target_reached ? '#27ae60' : '#f39c12'};">${dashboardData.daily.progress_percent}%</div>
                        <div class="metric-label">Complete</div>
                        <div class="metric-sublabel">${dashboardData.daily.target_reached ? '✅ Achieved' : '⏳ In Progress'}</div>
                    </div>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar-fill" style="width: ${dashboardData.daily.progress_percent}%;"></div>
                </div>
                <div style="text-align: center; font-weight: bold; color: #ecf0f1;">
                    ${dashboardData.daily.progress_percent}% of daily target achieved
                </div>
            </div>
        </div>

        <!-- System Status -->
        <div class="section-card">
            <div class="section-header">⚙️ Live System Status</div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-4">
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.system.battery_color};">${dashboardData.system.battery_soc}%</div>
                        <div class="metric-label">Battery SOC</div>
                        <div class="metric-sublabel">🔋 State of Charge</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.system.battery_status_color};">${dashboardData.system.battery_power}</div>
                        <div class="metric-label">Battery Power (W)</div>
                        <div class="metric-sublabel">${dashboardData.system.battery_status}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: #f39c12;">${dashboardData.system.generation}</div>
                        <div class="metric-label">Solar Generation (W)</div>
                        <div class="metric-sublabel">☀️ Solar Power</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.system.grid_color};">${dashboardData.system.grid_power}</div>
                        <div class="metric-label">Grid Power (W)</div>
                        <div class="metric-sublabel">${dashboardData.system.grid_status}</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Monthly Performance -->
        <div class="section-card">
            <div class="section-header">📅 Monthly Performance</div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-2">
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.monthly.performance_color};">${dashboardData.monthly.performance_ratio}</div>
                        <div class="metric-label">Performance vs Target</div>
                        <div class="metric-sublabel">${dashboardData.monthly.rolling_days} days average</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: #3498db;">${dashboardData.monthly.monthly_progress}%</div>
                        <div class="metric-label">Month Progress</div>
                        <div class="metric-sublabel">${dashboardData.monthly.rolling_total} / ${dashboardData.monthly.monthly_target} kWh</div>
                    </div>
                </div>
                <div style="text-align: center; margin-top: 10px; font-weight: bold; color: #ecf0f1;">
                    📆 ${dashboardData.monthly.days_remaining} days remaining in month
                </div>
            </div>
        </div>

        ${dashboardData.catchup ? `
        <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); border-radius: 15px; padding: 20px; margin: 20px 0; text-align: center;">
            <h5 style="font-size: 1.1rem; font-weight: 600; margin-bottom: 15px;">🚀 Catch-up Mode Active</h5>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div>
                    <div style="font-size: 1rem; font-weight: 600;">Total Deficit</div>
                    <div style="font-size: 1.5rem; font-weight: bold;">${dashboardData.catchup.total_deficit} kWh</div>
                    <small>Behind by ${dashboardData.catchup.shortfall_per_day} kWh/day</small>
                </div>
                <div>
                    <div style="font-size: 1rem; font-weight: 600;">Daily Boost</div>
                    <div style="font-size: 1.5rem; font-weight: bold;">+${dashboardData.catchup.catchup_per_day} kWh</div>
                    <small>Over next ${dashboardData.catchup.catchup_days} days</small>
                </div>
            </div>
        </div>
        ` : ''}

        <!-- Recent History -->
        <div class="section-card">
            <div class="section-header">📈 Recent History (Last 7 Days)</div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-7">
                    ${dashboardData.recent_history.map(day => `
                        <div class="metric-card" style="min-height: 120px;">
                            <div style="font-weight: bold; margin-bottom: 8px; color: #ecf0f1;">${day.date}</div>
                            <div style="font-size: 1rem; font-weight: 600; margin-bottom: 4px; color: ${day.achievement_color};">${day.export}</div>
                            <small style="color: #95a5a6; display: block; margin-bottom: 8px;">target: ${day.target}</small>
                            <div style="font-size: 0.7rem; color: #bdc3c7; margin-bottom: 8px;">${day.performance_ratio}</div>
                            <div style="font-size: 1.2rem;">${day.performance_icon}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>

        <!-- System Logs -->
        <div class="section-card">
            <div class="section-header">
                📝 System Logs (Last ${dashboardData.logs.recent_count} Events)
            </div>
            <div class="log-container">
                ${dashboardData.logs.entries.length > 0 ? 
                    dashboardData.logs.entries.map(log => `
                        <div class="log-entry ${Object.keys(log.data).length > 0 ? 'expandable' : ''} priority-${log.priority}" 
                             style="border-left-color: ${log.color};" 
                             onclick="toggleLogDetails('${log.id}')">
                            <div class="log-header">
                                <div>
                                    <span class="log-type-badge" style="background-color: ${log.color};">
                                        ${log.icon} ${log.type}
                                    </span>
                                </div>
                                <div class="log-timestamp">${log.timestamp}</div>
                            </div>
                            <div class="log-message">${log.message}</div>
                            ${Object.keys(log.data).length > 0 ? `
                                <div class="log-details" id="details-${log.id}">
                                    <strong>Full Message:</strong> ${log.full_message}<br><br>
                                    <strong>Details:</strong><br>
                                    ${Object.entries(log.data).map(([key, value]) => 
                                        `<strong>${key}:</strong> ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`
                                    ).join('<br>')}
                                </div>
                            ` : ''}
                        </div>
                    `).join('') 
                    : 
                    '<div style="text-align: center; color: #bdc3c7; padding: 20px; font-style: italic;">No recent log entries</div>'
                }
                <div class="log-summary">
                    📊 Showing ${dashboardData.logs.recent_count} of ${dashboardData.logs.total_count} total entries<br>
                    ⏱️ Logs update every 10 seconds<br>
                    📈 Live data updates every second<br>
                    💡 Click entries with details to expand
                </div>
            </div>
        </div>
    </div>
    
    <script>
        // Simple toggle function that works with Node-RED updates
        function toggleLogDetails(logId) {
            const details = document.getElementById('details-' + logId);
            if (details) {
                if (details.classList.contains('expanded')) {
                    details.classList.remove('expanded');
                } else {
                    details.classList.add('expanded');
                }
            }
        }
        
        // Auto-scroll to bottom for new critical logs
        window.addEventListener('load', function() {
            const criticalLogs = document.querySelectorAll('.log-entry.priority-critical');
            if (criticalLogs.length > 0) {
                const lastCritical = criticalLogs[criticalLogs.length - 1];
                if (lastCritical) {
                    setTimeout(() => {
                        lastCritical.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 500);
                }
            }
        });
    </script>
    `;
    
    msg.payload = {
        data: dashboardData,
        html: html,
        timestamp: new Date().toISOString()
    };
    
    return msg;
    
} catch (error) {
    node.error(`Dashboard UI Error: ${error.message}`);
    msg.payload = {
        error: error.message,
        html: `<div style="color: red; padding: 20px;">Dashboard Error: ${error.message}</div>`
    };
    return msg;
}