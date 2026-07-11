/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.

import cronParser from 'cron-parser';
import server from '@cocreate/server';

// ==========================================
// Module-Level Sandbox State (ESM Singleton)
// ==========================================
let crud = null;
let wsManager = null;
const scheduledJobs = {};

/**
 * Parses the schedule object and calculates the next execution time.
 * Takes into account cronExpression, startTime, skipDates, time, daysOfWeek, daysOfMonth, months, endTime, etc.
 * @param {Object} schedule - The schedule object containing cronExpression, startTime, etc.
 * @returns {string|null} nextExecutionTime - Calculated execution timestamp in ISO format, or null if endTime has passed.
 */
function getNextExecutionTime(schedule) {
    const now = new Date();
    let currentDateTime = now;

    // Use startTime if it's greater than now, otherwise use now
    if (schedule.startTime && new Date(schedule.startTime) > now) {
        currentDateTime = new Date(schedule.startTime);
    }

    // Apply skipDates: Skip the date if it matches any in skipDates
    if (schedule.skipDates && schedule.skipDates.includes(currentDateTime.toISOString().split('T')[0])) {
        currentDateTime = new Date(currentDateTime.getTime() + 24 * 60 * 60 * 1000);  // Skip to the next day
    }

    // Apply daysOfWeek: If the current day is not in the allowed days, skip to the next valid day
    if (schedule.daysOfWeek) {
        const dayOfWeek = currentDateTime.toLocaleString('en-US', { weekday: 'long', timeZone: schedule.timezone || 'UTC' });

        while (!schedule.daysOfWeek.includes(dayOfWeek)) {
            currentDateTime.setDate(currentDateTime.getDate() + 1);  // Move to the next day
        }
    }

    // Apply daysOfMonth: Ensure the next execution is on a valid day of the month
    if (schedule.daysOfMonth) {
        while (!schedule.daysOfMonth.includes(currentDateTime.getDate())) {
            currentDateTime.setDate(currentDateTime.getDate() + 1);  // Move to the next day
        }
    }

    // Apply months: Ensure the next execution falls within one of the allowed months
    if (schedule.months) {
        const monthName = currentDateTime.toLocaleString('en-US', { month: 'long', timeZone: schedule.timezone || 'UTC' });

        while (!schedule.months.includes(monthName)) {
            currentDateTime.setMonth(currentDateTime.getMonth() + 1);  // Move to the next month
        }
    }

    // Apply time: Set the execution time of day if specified
    if (schedule.time) {
        const [hours, minutes, seconds] = schedule.time.split(':');
        currentDateTime.setHours(hours, minutes, seconds);
    }

    // Apply endTime: Ensure the next execution time does not exceed the endTime
    if (schedule.endTime && new Date(currentDateTime) > new Date(schedule.endTime)) {
        return null;  // No further executions after endTime
    }

    // Now run the cronParser to handle cronExpression (if present) or fallback to currentDateTime
    if (schedule.cronExpression) {
        try {
            const interval = cronParser.parseExpression(schedule.cronExpression, {
                currentDate: currentDateTime,
                tz: schedule.timezone || 'UTC'
            });
            return interval.next().toISOString();
        } catch (err) {
            console.error('[@cocreate/cron-jobs] Cron parsing failed:', err);
            return null;
        }
    }

    return currentDateTime.toISOString();
}

/**
 * Marks the cron job status inside the platform database.
 * Normalizes input array payloads to preserve safety across organization contexts.
 */
async function updateCronJob(object) {
    if (!crud) return;
    try {
        const cronJobs = Array.isArray(object) ? object : [object];

        for (const job of cronJobs) {
            await crud.send({
                method: 'object.update',
                array: 'cron-jobs',
                object: [job],
                upsert: true,
                organization_id: job.organization_id
            });
            console.log(`[@cocreate/cron-jobs] Cron job for org ${job.organization_id} updated.`);
        }

        if (cronJobs.length > 0 && cronJobs[0].organization_id) {
            const firstJob = cronJobs[0];
            await crud.send({
                method: 'object.update',
                array: 'organizations',
                object: {
                    _id: firstJob.organization_id,
                    cronJobs
                },
                organization_id: process.env.organization_id
            });
            console.log(`[@cocreate/cron-jobs] Cron job list for org ${firstJob.organization_id} mapped.`);
        }
    } catch (error) {
        console.error('[@cocreate/cron-jobs] Error updating cron job records:', error);
    }
}

/**
 * Executes the scheduled cron job.
 * @param {Object} object - The cron-job object containing job details, schedule parameters, etc.
 */
async function executeCronJob(object) {
    console.log(`[@cocreate/cron-jobs] Executing cron job for org ${object.organization_id}`);

    try {
        if (!object.job && crud) {
            const data = await crud.send({
                method: 'object.read',
                array: 'cron-job',
                object: { _id: object._id },
                organization_id: object.organization_id
            });
            if (data.object && data.object[0]) {
                object = data.object[0];
            }
            console.log('[@cocreate/cron-jobs] Fetched cron job data:', object);
        }

        // Target Action Pipeline execution placeholder:
        // TODO: execute cron using lazyloader.webhook() or server-native lazyloader routing
        
        object.nextExecutionTime = getNextExecutionTime(object.schedule);
        if (!object.nextExecutionTime) {
            object.active = false;
            object.status = 'completed';
        } else {
            // Re-queue and release the lock for the next interval run
            object.status = 'scheduled';
            object.serverId = null;
            object.workerId = null;
        }

        await updateCronJob(object);
    } catch (error) {
        console.error(`[@cocreate/cron-jobs] Error executing cron job ${object._id}:`, error);
    }
}

/**
 * Schedules a cron job to be executed at a specific datetime.
 * @param {Object} object - The cron-job configuration footprint.
 */
function scheduleCronJob(object) {
    const delay = new Date(object.nextExecutionTime) - new Date();

    if (delay <= 0) {
        executeCronJob(object);
        return;
    }

    console.log(`[@cocreate/cron-jobs] Scheduling cron job for org ${object.organization_id} in ${delay / 1000} seconds`);

    const scheduledObj = {
        _id: object._id,
        nextExecutionTime: object.nextExecutionTime,
        status: object.status,
        clusterId: 'default-cluster', 
        serverId: server?.instanceId || server?.serverId || 'default-server',
        workerId: server?.workerId !== undefined ? server.workerId : 'standalone',
        organization_id: object.organization_id
    };

    scheduledJobs[object._id] = setTimeout(() => {
        executeCronJob(scheduledObj);
    }, delay);
}

/**
 * Handles CRUD events to schedule cron jobs dynamically.
 * @param {Object} data - The data object emitted from CRUD operations.
 */
async function handleCrudEvent(data) {
    if (data.array !== 'cron-job') {
        return;  // Ignore non-cron-job events
    }

    // Iterate over the jobs in the data.object array
    for (let i = 0; i < data.object.length; i++) {
        if (data.method === 'object.delete' || data.object[i].active === false) {
            const timeoutId = scheduledJobs[data.object[i]._id];

            if (timeoutId) {
                clearTimeout(timeoutId); // Cancel the timeout if it exists
                delete scheduledJobs[data.object[i]._id]; // Remove the reference
            }

            data.object.splice(i, 1);
            i--;  // Adjust the index after removal
            continue;
        }

        const nextExecutionTime = getNextExecutionTime(data.object[i].schedule);

        if (nextExecutionTime) {
            // If already scheduled for the exact same block, skip duplicate scheduling
            if (scheduledJobs[data.object[i]._id]) {
                continue;
            }

            const timeUntilExecution = new Date(nextExecutionTime) - new Date();
            data.object[i].nextExecutionTime = nextExecutionTime;

            // If the next execution is within the next 5 minutes, schedule the job
            if (timeUntilExecution <= 5 * 60 * 1000 && timeUntilExecution > 0) {
                // Claim the job locally and coordinate across nodes/cores
                data.object[i].status = 'assigned';
                data.object[i].serverId = server?.instanceId || server?.serverId || 'default-server';
                data.object[i].workerId = server?.workerId !== undefined ? server.workerId : 'standalone';
                scheduleCronJob(data.object[i]);
            }
        } else {
            data.object.splice(i, 1);
            i--;  // Adjust the index after removal
        }
    }

    await updateCronJob(data.object);
}

/**
 * Polls the platform DB for cron jobs that are scheduled or potentially failed.
 * Any worker process hosting active sockets/procedures for an organization can safely execute this.
 */
async function pollForCronJobs() {
    if (!crud) return;
    console.log(`[@cocreate/cron-jobs] [Worker ${server?.workerId}] Polling for active organizations' cron jobs...`);

    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
    const oneMinuteAgo = new Date(now.getTime() - 1 * 60 * 1000);  // 1 minute past due jobs

    try {
        // Query organizations.
        const data = await crud.send({
            method: 'object.read',
            array: 'organizations',
            filter: {
                query: {
                    $or: [
                        {
                            $and: [
                                { 'cron-jobs.nextExecutionTime': { $elemMatch: { $lte: fiveMinutesFromNow, $gte: now } } }, // Match jobs in array within 5 minutes
                                { 'cron-jobs.status': { $elemMatch: { $ne: 'assigned' } } },   // Not already claimed/assigned
                                { 'cron-jobs.active': { $elemMatch: { $ne: false } } }   // Is active
                            ]
                        },
                        {
                            $and: [
                                { 'cron-jobs.nextExecutionTime': { $elemMatch: { $lt: oneMinuteAgo } } },   // Past due by 1 minute (possible crash recovery)
                                { 'cron-jobs.status': { $elemMatch: { $eq: 'assigned' } } },    // Marked assigned but execution failed to clear/update it
                                { 'cron-jobs.active': { $elemMatch: { $ne: false } } }   // Is active                           
                            ]
                        }
                    ]
                }
            },
            organization_id: process.env.organization_id
        });

        if (!data || !data.object) return;

        for (let i = 0; i < data.object.length; i++) {
            const cronJobs = data.object[i].cronJobs;
            if (!cronJobs) continue;

            const organizationId = data.object[i].organization_id;

            // Check each cron job in the organization's `cron-jobs` array
            for (let j = 0; j < cronJobs.length; j++) {
                if (scheduledJobs[cronJobs[j]._id]) continue;

                // Set assignment properties to claim this job cluster-wide
                cronJobs[j].status = 'assigned';
                cronJobs[j].clusterId = 'default-cluster';
                cronJobs[j].serverId = server?.instanceId || server?.serverId || 'default-server';
                cronJobs[j].workerId = server?.workerId !== undefined ? server.workerId : 'standalone';
                cronJobs[j].organization_id = organizationId;

                scheduleCronJob(cronJobs[j]);
            }

            await updateCronJob(cronJobs);
        }
    } catch (error) {
        console.error('[@cocreate/cron-jobs] Error polling for cron jobs:', error);
    }
}

/**
 * Adds a cron job reference to the platform database.
 * @param {string} organization_id - The organization ID.
 * @param {string} datetime - The datetime of the cron job to add to the platform DB.
 */
async function addToPlatformDB(organization_id, datetime) {
    if (!crud) return;
    console.log(`[@cocreate/cron-jobs] Adding cron job reference to platform DB for org ${organization_id}`);

    try {
        await crud.send({
            method: 'object.read',
            array: 'organizations',
            object: { _id: organization_id, nextCron: datetime },
            organization_id: process.env.organization_id
        });
        console.log(`[@cocreate/cron-jobs] Platform DB updated for org ${organization_id}`);
    } catch (error) {
        console.error(`[@cocreate/cron-jobs] Error updating platform DB for org ${organization_id}:`, error);
    }
}

/**
 * Finds and schedules the next cron job for the organization after one is executed.
 * @param {string} organization_id - The organization ID.
 */
async function findNextCronJob(organization_id) {
    if (!crud) return;
    console.log(`[@cocreate/cron-jobs] Finding next cron job for org ${organization_id}`);

    try {
        const nextJob = await crud.send({
            method: 'object.read',
            array: 'cron-job',
            $filter: {
                query: { organization_id },
                sort: [{ key: 'datetime', direction: 'asc' }],
                limit: 1
            },
            organization_id
        });

        if (nextJob && nextJob.object && nextJob.object.length > 0) {
            const { datetime } = nextJob.object[0];
            scheduleCronJob({ ...nextJob.object[0], nextExecutionTime: datetime });
        }
    } catch (error) {
        console.error(`[@cocreate/cron-jobs] Error finding next cron job for org ${organization_id}:`, error);
    }
}

/**
 * Self-Activating Auto-Initialization Loop.
 * Runs on static module import, polling background state to detect when the 
 * parent server core has fully executed its async initialization blocks.
 */
async function init() {
    if (server && server.isInitialized && server.crud && server.wsManager) {
        crud = server.crud;
        wsManager = server.wsManager;

        // Handle incoming realtime CRUD operations to dynamically reschedule active jobs
        process.on('crud-event', (event) => {
            handleCrudEvent(event);
        });

        console.log(`[@cocreate/cron-jobs] Cron monitoring active on Worker Core ${server.workerId}`);
        
        // Initial boot poll
        pollForCronJobs();

        // Setup the 5-minute interval cycle
        setInterval(() => {
            pollForCronJobs();
        }, 5 * 60 * 1000);
        
    } else {
        // If the server core isn't fully booted/initialized yet, retry in 500ms
        setTimeout(init, 500);
    }
}

// Start auto-activation monitoring sequence instantly upon import evaluation
init();

export default {
    init,
    getNextExecutionTime,
    executeCronJob,
    scheduleCronJob,
    handleCrudEvent,
    pollForCronJobs,
    addToPlatformDB,
    findNextCronJob
};