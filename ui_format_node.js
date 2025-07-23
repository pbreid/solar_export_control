
try {
    // Get all the energy management data
    const targetCalc = global.get('target_calculation', 'file') || {};
    const currentState = global.get('energy_management_state') || 'UNKNOWN';
    const dailyExport = (global.get('export_daily') || 0) / 1000; // Convert Wh to kWh
    const batterySoc = global.get('victron_soc') || 0;
    const generation = global.get('generation') || 0;
    const gridPower = global.get('grid_power') || 0;
    const batteryPower = global.get('battery_power') || 0;
    const exportHistory = global.get('export_history_30days', 'file') || [];

    node.warn("batteryPower = " + batteryPower);
    if (batteryPower < 0) node.warn("in");


    // TESTING: Simulate over-performance data (REMOVE AFTER TESTING)
    const TESTING_OVER_PERFORMANCE = false; // Set to false to disable testing

    if (TESTING_OVER_PERFORMANCE) {
        // Inject test data for over-performance scenario
        targetCalc.adjustment_reason = 'over_performing';
        targetCalc.performance_ratio = 0.943; // 135% - way over target
        targetCalc.rolling_days = 20;
        targetCalc.static_monthly_target = 23.5;
        targetCalc.rolling_export_total = 635; // 635 kWh vs 470 expected (23.5 * 20)
        targetCalc.excess_per_day = 8.25; // 8.25 kWh per day excess
        targetCalc.monthly_export_target = 728.5;

        console.log('TESTING MODE: Over-performance simulation active');
    }


    // Debug log for grid power
    // console.log('Grid Power Debug:', {raw: gridPower, type: typeof gridPower});
    // console.log('Grid Power Comparisons:', {
    //     'gridPower <= -100': gridPower <= -100,
    //     'gridPower >= 100': gridPower >= 100,
    //     'actual value': gridPower
    // });
    
    // Helper functions
    function formatNumber(num, decimals = 1) {
        if (typeof num !== 'number') return '0.0';
        return Math.abs(num).toFixed(decimals); // Ensure we always return positive
    }
    
    function formatPercent(num, decimals = 1) {
        return typeof num === 'number' ? (num * 100).toFixed(decimals) + '%' : '0.0%';
    }
    
    function getStateColor(state) {
        const colors = {
            'EXPORT_PRIORITY': '#4CAF50',    // Green
            'BATTERY_STORAGE': '#2196F3',    // Blue  
            'LOAD_MANAGEMENT': '#FF9800',    // Orange
            'SELF_CONSUME': '#9C27B0',       // Purple
            'SAFE_MODE': '#F44336',          // Red
            'DISABLED': '#757575'            // Grey
        };
        return colors[state] || '#757575';
    }
    
    function getPerformanceIcon(export_val, target_val) {
        const ratio = export_val / target_val;
        if (ratio >= 1.1) {
            return '⬆️'; // Significant over-performance (110%+)
        } else if (ratio >= 1.05) {
            return '↗️'; // Good over-performance (105-110%)
        } else if (ratio >= 0.95) {
            return '✅'; // Close to target (95-105%)
        } else if (ratio >= 0.8) {
            return '↘️'; // Under-performing but not terrible (80-95%)
        } else {
            return '⬇️'; // Significant under-performance (<80%)
        }
    }

    function getPerformanceColor(ratio) {
        // Handle both single ratio input and two-parameter input for backward compatibility
        if (arguments.length === 2) {
            const export_val = arguments[0];
            const target_val = arguments[1];
            ratio = export_val / target_val;
        }
        
        if (ratio >= 1.1) return '#F44336';         // Red - way over performing (>110%)
        if (ratio >= 1.05) return '#FF9800';        // Orange - over performing (105-110%)
        if (ratio >= 1.0) return '#4CAF50';         // Green - good performance (100-105%)
        if (ratio >= 0.9) return '#8BC34A';         // Light green - ok performance (90-100%)
        if (ratio >= 0.8) return '#FF9800';         // Orange - below target (80-90%)
        return '#F44336';                           // Red - poor performance (<80%)
    }

    
    // Calculate current month info
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    
    // Build the dashboard data
    const dashboardData = {
        // Header Status
        status: {
            current_state: currentState,
            state_color: getStateColor(currentState),
            timestamp: new Date().toLocaleString('en-AU', {
                timeZone: 'Australia/Brisbane',
                year: 'numeric',
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            })
        },
        
        // Daily Performance
        daily: {
            export_today: formatNumber(dailyExport),
            target_today: formatNumber(targetCalc.adjusted_target || 0),
            target_reached: dailyExport >= (targetCalc.adjusted_target || 0),
            progress_percent: Math.min(100, (dailyExport / (targetCalc.adjusted_target || 1)) * 100).toFixed(1),
            progress_color: dailyExport >= (targetCalc.adjusted_target || 0) ? '#4CAF50' : '#2196F3'
        },
        
        // Current System Status  
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
        
        // Monthly Performance
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
        
        // Catch-up Information (if under-performing)
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
            recommended_reduction: formatNumber((targetCalc.excess_per_day || 0) * 0.8) // Suggest reducing by 80% of excess
        } : null,
        
        // Recent History (last 7 days)
        recent_history: exportHistory.slice(-7).map(day => {
            const exportVal = parseFloat(day.export) || 0;
            const targetVal = parseFloat(day.target) || 1; // Avoid division by zero
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
        })
    };
    
    // Create responsive HTML that works on both PC and mobile
    const html = `
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        /* Responsive design for all screen sizes */
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
        
        * {
            box-sizing: border-box;
        }
        
        .section-card {
            background: #34495e;
            border-radius: 6px;
            margin-bottom: 10px;
            border: 1px solid #4a5f7a;
            width: 100%;
            flex-shrink: 0;
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
        
        /* Mobile First - 1 column on small screens */
        .metric-grid-3 {
            grid-template-columns: 1fr;
        }
        
        .metric-grid-2 {
            grid-template-columns: 1fr;
        }
        
        .metric-grid-4 {
            grid-template-columns: 1fr;
        }
        
        .metric-grid-7 {
            grid-template-columns: repeat(2, 1fr);
        }
        
        /* Small Mobile - 2 columns for better space usage */
        @media (min-width: 450px) {
            .metric-grid-3 {
                grid-template-columns: repeat(2, 1fr);
            }
            
            .metric-grid-2 {
                grid-template-columns: repeat(2, 1fr);
            }
            
            .metric-grid-4 {
                grid-template-columns: repeat(2, 1fr);
            }
            
            .metric-grid-7 {
                grid-template-columns: repeat(2, 1fr);
            }
        }
        
        /* Tablet - 2 columns */
        @media (min-width: 600px) {
            .metric-grid-3 {
                grid-template-columns: repeat(2, 1fr);
            }
            .metric-grid-2 {
                grid-template-columns: repeat(2, 1fr);
            }
            .metric-grid-7 {
                grid-template-columns: repeat(3, 1fr);
            }
        }
        
        /* Desktop - 4 columns for system status when we have space */
        @media (min-width: 900px) {
            .metric-grid-3 {
                grid-template-columns: repeat(3, 1fr);
            }
            .metric-grid-4 {
                grid-template-columns: repeat(4, 1fr);
            }
            .metric-grid-7 {
                grid-template-columns: repeat(4, 1fr);
            }
        }
        
        /* Large Desktop - Max columns */
        @media (min-width: 1200px) {
            .metric-grid-4 {
                grid-template-columns: repeat(4, 1fr);
            }
            .metric-grid-7 {
                grid-template-columns: repeat(7, 1fr);
            }
        }
        
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
            width: 100%;
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
        
        .catchup-alert {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            border-radius: 15px;
            padding: 20px;
            margin: 20px 0;
            text-align: center;
            width: 100%;
        }
        
        .catchup-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 20px;
            margin-top: 15px;
            width: 100%;
        }
        
        @media (min-width: 600px) {
            .catchup-grid {
                grid-template-columns: 1fr 1fr;
            }
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
        
        /* Mobile adjustments - optimized for fixed height container */
        @media (max-width: 600px) {
            .energy-dashboard {
                padding: 4px !important;
                margin: 0 !important;
                border-radius: 4px;
                width: 68% !important;
                max-width: 68% !important;
                transform: scale(0.85);
                transform-origin: top left;
            }
            
            .section-card {
                margin-bottom: 6px;
                width: 100%;
                border-radius: 4px;
            }
            
            .section-header {
                font-size: 0.75rem;
                padding: 4px 6px;
            }
            
            .metric-card {
                padding: 6px 3px;
                min-height: 60px;
                border-radius: 3px;
            }
            
            .metric-value {
                font-size: 0.9rem;
                margin-bottom: 2px;
            }
            
            .metric-label {
                font-size: 0.6rem;
                margin-bottom: 1px;
            }
            
            .metric-sublabel {
                font-size: 0.5rem;
            }
            
            .header-container {
                margin-bottom: 8px;
                padding: 0;
            }
            
            .header-container h1 {
                font-size: 1rem !important;
                margin-bottom: 4px !important;
            }
            
            .state-badge {
                font-size: 0.65rem;
                padding: 2px 6px;
            }
            
            .catchup-alert {
                padding: 8px 6px;
                margin: 8px 0;
                border-radius: 4px;
            }
            
            .catchup-grid {
                gap: 8px;
            }
            
            /* Very tight spacing on mobile */
            .metric-grid {
                gap: 3px;
            }
            
            /* 3 columns on mobile for better space usage */
            .metric-grid-3 {
                grid-template-columns: repeat(3, 1fr) !important;
            }
            
            .metric-grid-4 {
                grid-template-columns: repeat(3, 1fr) !important;
            }
            
            .metric-grid-2 {
                grid-template-columns: repeat(2, 1fr) !important;
            }
            
            .metric-grid-7 {
                grid-template-columns: repeat(3, 1fr) !important;
            }
            
            /* Progress bar adjustments */
            .progress-bar-container {
                margin: 4px 0;
                height: 4px;
            }
            
            /* Section padding override */
            .section-card > div[style*="padding"] {
                padding: 6px 4px !important;
            }
        }
        
        /* Extra small devices - Single column for very narrow screens */
        @media (max-width: 400px) {
            .energy-dashboard {
                padding: 6px !important;
                margin: 0 !important;
            }
            
            .section-header {
                font-size: 0.8rem;
                padding: 5px 6px;
            }
            
            .metric-card {
                padding: 6px 3px;
                min-height: 70px;
            }
            
            .metric-value {
                font-size: 1rem;
            }
            
            .metric-label {
                font-size: 0.65rem;
            }
            
            .metric-sublabel {
                font-size: 0.55rem;
            }
            
            .header-container h1 {
                font-size: 1.2rem !important;
            }
            
            .header-container {
                padding: 0 3px;
            }
            
            /* Extra tight spacing */
            .metric-grid {
                gap: 4px;
            }
            
            .catchup-alert {
                padding: 10px 6px;
            }
            
            /* Single column only on very small screens */
            .metric-grid-3,
            .metric-grid-2,
            .metric-grid-4,
            .metric-grid-7 {
                grid-template-columns: 1fr;
            }
        }
        
        /* Desktop - larger screens get more columns and bigger text */
        @media (min-width: 1200px) {
            .energy-dashboard {
                padding: 15px;
            }
            
            .metric-value {
                font-size: 1.6rem;
            }
            
            .section-header {
                font-size: 1rem;
                padding: 10px 15px;
            }
            
            .header-container h1 {
                font-size: 1.6rem !important;
            }
            
            .metric-card {
                min-height: 100px;
                padding: 12px;
            }
            
            .section-card {
                margin-bottom: 12px;
            }
        }
        
        /* Override Node-RED dashboard styles - lighter touch */
        .nr-dashboard-template {
            padding: 0 !important;
            margin: 0 !important;
        }
        
        .ui-card-panel {
            padding: 0 !important;
        }
        
        /* Mobile-only overrides */
        @media (max-width: 600px) {
            .nr-dashboard-template,
            .ui-card-panel,
            md-card,
            md-card-content {
                padding: 0 !important;
                margin: 0 !important;
            }
        }
        
        /* Container - optimized for fixed height Node-RED template */
        .energy-dashboard {
            background: #2c3e50;
            color: white;
            font-family: Arial, sans-serif;
            width: 100%;
            max-width: 100%;
            height: 100%;
            max-height: 100%;
            margin: 0;
            padding: 10px;
            box-sizing: border-box;
            border-radius: 8px;
            overflow-y: auto;
            overflow-x: hidden;
        }
    </style>
    
    <div class="energy-dashboard">
        <!-- Header -->
        <div class="header-container">
            <h1 style="font-size: 1.8rem; font-weight: bold; margin-bottom: 10px; color: #ecf0f1;">
                ⚡ Energy Management System
            </h1>
            <div class="state-badge" style="background-color: ${dashboardData.status.state_color};">
                ${dashboardData.status.current_state}
            </div>
            <p class="timestamp">
                🕐 ${dashboardData.status.timestamp}
            </p>
        </div>

        <!-- Today's Performance -->
        <div class="section-card">
            <div class="section-header">
                📊 Today's Performance
            </div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-3">
                    <div class="metric-card">
                        <div class="metric-value" style="color: #27ae60;">
                            ${dashboardData.daily.export_today}
                        </div>
                        <div class="metric-label">kWh Exported</div>
                        <div class="metric-sublabel">📈 Daily Export</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: #3498db;">
                            ${dashboardData.daily.target_today}
                        </div>
                        <div class="metric-label">Daily Target</div>
                        <div class="metric-sublabel">🎯 Target Goal</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.daily.target_reached ? '#27ae60' : '#f39c12'};">
                            ${dashboardData.daily.progress_percent}%
                        </div>
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
            <div class="section-header">
                ⚙️ Live System Status
            </div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-4">
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.system.battery_color};">
                            ${dashboardData.system.battery_soc}%
                        </div>
                        <div class="metric-label">Battery SOC</div>
                        <div class="metric-sublabel">
                            🔋 State of Charge
                        </div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.system.battery_status_color};">
                            ${dashboardData.system.battery_power}
                        </div>
                        <div class="metric-label">Battery Power (W)</div>
                        <div class="metric-sublabel">
                            ${dashboardData.system.battery_status}
                        </div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: #f39c12;">
                            ${dashboardData.system.generation}
                        </div>
                        <div class="metric-label">Solar Generation (W)</div>
                        <div class="metric-sublabel">☀️ Solar Power</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.system.grid_color};">
                            ${dashboardData.system.grid_power}
                        </div>
                        <div class="metric-label">Grid Power (W)</div>
                        <div class="metric-sublabel">
                            ${dashboardData.system.grid_status}
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Monthly Performance -->
        <div class="section-card">
            <div class="section-header">
                📅 Monthly Performance
            </div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-2">
                    <div class="metric-card">
                        <div class="metric-value" style="color: ${dashboardData.monthly.performance_color};">
                            ${dashboardData.monthly.performance_ratio}
                            ${dashboardData.monthly.performance_ratio.includes('%') && parseFloat(dashboardData.monthly.performance_ratio) >= 110 ? ' ⚠️' : ''}
                        </div>
                        <div class="metric-label">Performance vs Target</div>
                        <div class="metric-sublabel">${dashboardData.monthly.rolling_days} days average</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" style="color: #3498db;">
                            ${dashboardData.monthly.monthly_progress}%
                        </div>
                        <div class="metric-label">Month Progress</div>
                        <div class="metric-sublabel">
                            ${dashboardData.monthly.rolling_total} / ${dashboardData.monthly.monthly_target} kWh
                        </div>
                    </div>
                </div>
                <div style="text-align: center; margin-top: 10px; font-weight: bold; color: #ecf0f1;">
                    📆 ${dashboardData.monthly.days_remaining} days remaining in month
                </div>
            </div>
        </div>

        ${dashboardData.over_performance ? `
        <!-- Over-Performance Warning -->
        <div style="
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
            border: 2px solid #c44569;
            border-radius: 15px;
            padding: 20px;
            margin: 20px 0;
            text-align: center;
        ">
            <div style="text-align: center;">
                <h5 style="font-size: 1.1rem; font-weight: 600; margin-bottom: 15px;">
                    ⚠️ Over-Performance Alert
                </h5>
                <div class="catchup-grid">
                    <div>
                        <div style="font-size: 1rem; font-weight: 600;">Excess Production</div>
                        <div style="font-size: 1.5rem; font-weight: bold;">${dashboardData.over_performance.total_excess} kWh</div>
                        <small>Above target (+${dashboardData.over_performance.excess_per_day} kWh/day)</small>
                    </div>
                    <div>
                        <div style="font-size: 1rem; font-weight: 600;">Suggested Action</div>
                        <div style="font-size: 1.5rem; font-weight: bold;">-${dashboardData.over_performance.recommended_reduction} kWh/day</div>
                        <small>Consider reducing daily export target</small>
                    </div>
                </div>
                <div style="margin-top: 15px; font-size: 0.9rem; opacity: 0.9;">
                    <strong>Performance: ${formatPercent(dashboardData.over_performance.performance_ratio)}</strong> of monthly target
                    <br>
                    💡 Consider using excess for hot water, EV charging, or other loads
                </div>
            </div>
        </div>
        ` : ''}

        ${dashboardData.catchup ? `
        <!-- Catch-up Alert -->
        <div class="catchup-alert">
            <div style="text-align: center;">
                <h5 style="font-size: 1.1rem; font-weight: 600; margin-bottom: 15px;">
                    🚀 Catch-up Mode Active
                </h5>
                <div class="catchup-grid">
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
        </div>
        ` : ''}

        <!-- Recent History -->
        <div class="section-card">
            <div class="section-header">
                📈 Recent History (Last 7 Days)
            </div>
            <div style="padding: 15px;">
                <div class="metric-grid metric-grid-7">
                    ${dashboardData.recent_history.map(day => `
                        <div class="metric-card" style="min-height: 140px;">
                            <div style="font-weight: bold; margin-bottom: 8px; color: #ecf0f1;">${day.date}</div>
                            <div style="font-size: 1rem; font-weight: 600; margin-bottom: 4px; color: ${day.achievement_color};">
                                ${day.export}
                            </div>
                            <small style="color: #95a5a6; display: block; margin-bottom: 8px;">target: ${day.target}</small>
                            <div style="font-size: 0.7rem; color: #bdc3c7; margin-bottom: 8px;">
                                ${day.performance_ratio}
                            </div>
                            <div style="font-size: 1.4rem;">
                                ${day.performance_icon}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
    
    // Return both structured data and HTML for different UI components
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