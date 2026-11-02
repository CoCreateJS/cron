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
// For details, visit <https://CoCreateJS.com/licenses/> or contact us at sales@CoCreateJS.com.

import server from '@cocreate/cluster';

let crud = null;
let wsManager = null;
const scheduledJobs = {};

/**
 * Safe helper to retrieve localized or UTC date part names natively.
 * @private
 * @environment server
 */
function getFormattedDatePart(date, type, timezone = 'UTC') {
    return date.toLocaleString('en-US', { [type]: 'long', timeZone: timezone });
}

/**
 * Calculates the last day of the month for any given UTC year/month.
 * @private
 * @environment server
 */
function getLastDayOfMonthUTC(year, monthIndex) {
    // Setting day to 0 of monthIndex + 1 yields the last day of monthIndex
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Custom 5-Part Cron Field Parser (Zero external dependencies).
 * Handles ranges (1-5), lists (1,2,3), wildcards (*), step values (* /15, 1-30/5), and string aliases.
 * @private
 * @environment server
 */
function parseCronField(field, min, max, nameMap = {}) {
    field = field.trim().toUpperCase();

    // Replace string aliases if present (e.g., JAN-DEC or SUN-SAT)
    for (const [name, val] of Object.entries(nameMap)) {
        field = field.replace(new RegExp(name, 'g'), val);
    }

    const allowed = new Set();
    const parts = field.split(',');

    for (const part of parts) {
        if (part.includes('/')) {
            const [rangeStr, stepStr] = part.split('/');
            const step = parseInt(stepStr, 10) || 1;
            let start = min;
            let end = max;

            if (rangeStr !== '*') {
                if (rangeStr.includes('-')) {
                    const [s, e] = rangeStr.split('-').map(Number);
                    start = s;
                    end = e;
                } else {
                    start = parseInt(rangeStr, 10);
                }
            }
            for (let i = start; i <= end; i += step) {
                if (i >= min && i <= max) allowed.add(i);
            }
        } else if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            for (let i = start; i <= end; i++) {
                if (i >= min && i <= max) allowed.add(i);
            }
        } else if (part === '*') {
            for (let i = min; i <= max; i++) allowed.add(i);
        } else {
            const val = parseInt(part, 10);
            if (!isNaN(val) && val >= min && val <= max) {
                allowed.add(val);
            }
        }
    }
    return allowed;
}

/**
 * Tokenizes standard 5-part cron expressions into match sets.
 * @private
 * @environment server
 */
function parseCronExpression(expression) {
    if (!expression || typeof expression !== 'string') return null;
    const tokens = expression.trim().split(/\s+/);
    if (tokens.length !== 5) return null;

    const monthNames = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
    const dayNames = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

    return {
        minutes: parseCronField(tokens[0], 0, 59),
        hours: parseCronField(tokens[1], 0, 23),
        daysOfMonth: parseCronField(tokens[2], 1, 31),
        months: parseCronField(tokens[3], 1, 12, monthNames),
        daysOfWeek: parseCronField(tokens[4], 0, 6, dayNames)
    };
}

/**
 * Checks if a specific UTC date instance matches a parsed 5-part cron object.
 * @private
 * @environment server
 */
function matchesCron(parsedCron, date) {
    const month = date.getUTCMonth() + 1; // 1-12
    const dayOfMonth = date.getUTCDate(); // 1-31
    const dayOfWeek = date.getUTCDay(); // 0-6
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();

    if (!parsedCron.minutes.has(minutes)) return false;
    if (!parsedCron.hours.has(hours)) return false;
    if (!parsedCron.months.has(month)) return false;

    const domHasAll = parsedCron.daysOfMonth.size === 31;
    const dowHasAll = parsedCron.daysOfWeek.size === 7;

    // Standard Cron rule: If both DOM and DOW are specified (neither is *), either matching triggers execution (OR logic).
    if (!domHasAll && !dowHasAll) {
        if (!parsedCron.daysOfMonth.has(dayOfMonth) && !parsedCron.daysOfWeek.has(dayOfWeek)) {
            return false;
        }
    } else {
        if (!parsedCron.daysOfMonth.has(dayOfMonth)) return false;
        if (!parsedCron.daysOfWeek.has(dayOfWeek)) return false;
    }

    return true;
}

/**
 * Calculates the next execution time for standard 5-part cron strings natively.
 * @private
 * @environment server
 */
function getNextCronExecution(cronExpression, startFromDate, skipDates = []) {
    const parsed = parseCronExpression(cronExpression);
    if (!parsed) return null;

    let current = new Date(startFromDate.getTime());
    current.setUTCSeconds(0, 0);
    current.setUTCMinutes(current.getUTCMinutes() + 1); // Step forward to next minute

    const maxSearchMinutes = 525600; // 1-year upper bound protection
    let counter = 0;

    while (counter < maxSearchMinutes) {
        counter++;
        const isoDateStr = current.toISOString().split('T')[0];

        // Evaluate skipDates
        if (skipDates && skipDates.includes(isoDateStr)) {
            current.setUTCDate(current.getUTCDate() + 1);
            current.setUTCHours(0, 0, 0, 0);
            continue;
        }

        if (matchesCron(parsed, current)) {
            return current.toISOString();
        }

        // Fast-forward month mismatch
        const month = current.getUTCMonth() + 1;
        if (!parsed.months.has(month)) {
            current.setUTCMonth(current.getUTCMonth() + 1);
            current.setUTCDate(1);
            current.setUTCHours(0, 0, 0, 0);
            continue;
        }

        // Fast-forward day mismatch if DOW is wildcard
        const dom = current.getUTCDate();
        if (parsed.daysOfWeek.size === 7 && !parsed.daysOfMonth.has(dom)) {
            current.setUTCDate(current.getUTCDate() + 1);
            current.setUTCHours(0, 0, 0, 0);
            continue;
        }

        // Fast-forward hour mismatch
        const hour = current.getUTCHours();
        if (!parsed.hours.has(hour)) {
            current.setUTCHours(current.getUTCHours() + 1);
            current.setUTCMinutes(0, 0, 0);
            continue;
        }

        current.setUTCMinutes(current.getUTCMinutes() + 1);
    }

    return null;
}

/**
 * Parses the schedule object and calculates the next execution time natively in UTC.
 * Supports cronExpression, startTime, skipDates, time, daysOfWeek, daysOfMonth, endOfMonth, months, endTime, etc.
 * @param {Object} schedule - The schedule object containing custom fields or cronExpression.
 * @returns {string|null} nextExecutionTime - Calculated ISO timestamp in UTC, or null if endTime has passed.
 * @public
 * @environment server
 */
function getNextExecutionTime(schedule) {
    if (!schedule) return null;

    const now = new Date();
    let currentDateTime = new Date();

    // 1. Establish UTC start baseline
    if (schedule.startTime && new Date(schedule.startTime) > now) {
        currentDateTime = new Date(schedule.startTime);
    }

    const timezone = schedule.timezone || 'UTC';

    // 2. If standard 5-part cron expression exists, use native parser
    if (schedule.cronExpression) {
        const nextCronRun = getNextCronExecution(schedule.cronExpression, currentDateTime, schedule.skipDates);
        if (nextCronRun && schedule.endTime && new Date(nextCronRun) > new Date(schedule.endTime)) {
            return null;
        }
        return nextCronRun;
    }

    // 3. Object-based custom schedule evaluation with safety bounds
    let safetyCounter = 0;
    const maxSafetyIterations = 1000;

    // Apply time of day if set (formatted HH:MM or HH:MM:SS)
    if (schedule.time) {
        const [hours, minutes, seconds] = schedule.time.split(':').map(Number);
        currentDateTime.setUTCHours(hours || 0, minutes || 0, seconds || 0, 0);

        if (currentDateTime < now) {
            currentDateTime.setUTCDate(currentDateTime.getUTCDate() + 1);
        }
    }

    while (safetyCounter < maxSafetyIterations) {
        safetyCounter++;

        const isoDateStr = currentDateTime.toISOString().split('T')[0];

        // Check skipDates
        if (schedule.skipDates && schedule.skipDates.includes(isoDateStr)) {
            currentDateTime.setUTCDate(currentDateTime.getUTCDate() + 1);
            continue;
        }

        // Check months
        if (schedule.months && schedule.months.length > 0) {
            const currentMonth = getFormattedDatePart(currentDateTime, 'month', timezone);
            if (!schedule.months.includes(currentMonth)) {
                currentDateTime.setUTCMonth(currentDateTime.getUTCMonth() + 1);
                currentDateTime.setUTCDate(1);
                continue;
            }
        }

        // Check daysOfMonth and end-of-month / "L" keyword
        if (schedule.daysOfMonth && schedule.daysOfMonth.length > 0) {
            const currentDom = currentDateTime.getUTCDate();
            const year = currentDateTime.getUTCFullYear();
            const monthIdx = currentDateTime.getUTCMonth();
            const lastDay = getLastDayOfMonthUTC(year, monthIdx);

            const isAllowedDom = schedule.daysOfMonth.some((day) => {
                if (day === 'L' || day === 'end-of-month') return currentDom === lastDay;
                return Number(day) === currentDom;
            });

            if (!isAllowedDom) {
                currentDateTime.setUTCDate(currentDateTime.getUTCDate() + 1);
                continue;
            }
        } else if (schedule.endOfMonth) {
            // Direct object property for end-of-month scheduling
            const currentDom = currentDateTime.getUTCDate();
            const year = currentDateTime.getUTCFullYear();
            const monthIdx = currentDateTime.getUTCMonth();
            const lastDay = getLastDayOfMonthUTC(year, monthIdx);

            if (currentDom !== lastDay) {
                currentDateTime.setUTCDate(currentDateTime.getUTCDate() + 1);
                continue;
            }
        }

        // Check daysOfWeek
        if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0) {
            const currentDayOfWeek = getFormattedDatePart(currentDateTime, 'weekday', timezone);
            if (!schedule.daysOfWeek.includes(currentDayOfWeek)) {
                currentDateTime.setUTCDate(currentDateTime.getUTCDate() + 1);
                continue;
            }
        }

        // Verify Expiration / EndTime
        if (schedule.endTime && currentDateTime > new Date(schedule.endTime)) {
            return null;
        }

        return currentDateTime.toISOString();
    }

    console.warn('[@cocreate/cron] Max safety iteration reached for schedule:', schedule);
    return null;
}

/**
 * Marks the cron job status inside the platform database.
 * Normalizes input array payloads to preserve safety across organization contexts.
 * @private
 * @environment server
 */
async function updateCronJob(object) {
    if (!crud) return;
    try {
        const cronJobs = Array.isArray(object) ? object : [object];
        if (cronJobs.length === 0) return;

        for (const job of cronJobs) {
            await crud.send({
                method: 'object.update',
                array: 'cron-jobs',
                object: [job],
                upsert: true,
                organization_id: job.organization_id
            });
            console.log(`[@cocreate/cron] Cron job ${job._id} for org ${job.organization_id} updated.`);
        }

        if (cronJobs[0].organization_id) {
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
            console.log(`[@cocreate/cron] Cron job list for org ${firstJob.organization_id} mapped.`);
        }
    } catch (error) {
        console.error('[@cocreate/cron] Error updating cron job records:', error);
    }
}

/**
 * Triggers the defined job action or payload webhook.
 * @private
 * @environment server
 */
async function triggerJobAction(job) {
    console.log(`[@cocreate/cron] Triggering pipeline action for job ${job._id}`);

    try {
        if (server?.lazyloader?.webhook) {
            await server.lazyloader.webhook(job);
        } else if (wsManager && job.action) {
            await wsManager.broadcast({
                target: job.action,
                data: job
            });
        }
    } catch (err) {
        console.error(`[@cocreate/cron] Action execution failed for job ${job._id}:`, err);
    }
}

/**
 * Executes the scheduled cron job.
 * @param {Object} object - The cron-job object containing job details, schedule parameters, etc.
 * @public
 * @environment server
 */
async function executeCronJob(object) {
    console.log(`[@cocreate/cron] Executing cron job ${object._id} for org ${object.organization_id}`);

    if (scheduledJobs[object._id]) {
        delete scheduledJobs[object._id];
    }

    try {
        if (!object.job && crud) {
            const data = await crud.send({
                method: 'object.read',
                array: 'cron-job',
                object: { _id: object._id },
                organization_id: object.organization_id
            });
            if (data.object && data.object[0]) {
                object = { ...data.object[0], ...object };
            }
        }

        // Execute target payload / AST action
        await triggerJobAction(object);

        // Recalculate next execution window in UTC
        object.nextExecutionTime = getNextExecutionTime(object.schedule);
        if (!object.nextExecutionTime) {
            object.active = false;
            object.status = 'completed';
        } else {
            object.status = 'scheduled';
            object.serverId = null;
            object.workerId = null;
        }

        await updateCronJob(object);
    } catch (error) {
        console.error(`[@cocreate/cron] Error executing cron job ${object._id}:`, error);
    }
}

/**
 * Schedules a cron job in-memory to be executed at a specific UTC datetime.
 * @param {Object} object - The cron-job configuration footprint.
 * @public
 * @environment server
 */
function scheduleCronJob(object) {
    if (!object || !object._id || !object.nextExecutionTime) return;

    if (scheduledJobs[object._id]) {
        clearTimeout(scheduledJobs[object._id]);
        delete scheduledJobs[object._id];
    }

    const delay = new Date(object.nextExecutionTime) - new Date();

    if (delay <= 0) {
        executeCronJob(object);
        return;
    }

    console.log(`[@cocreate/cron] Scheduling job ${object._id} for org ${object.organization_id} in ${(delay / 1000).toFixed(1)} seconds`);

    const scheduledObj = { ...object };

    scheduledJobs[object._id] = setTimeout(() => {
        executeCronJob(scheduledObj);
    }, delay);
}

/**
 * Handles CRUD events to schedule cron jobs dynamically without array mutation bugs.
 * @param {Object} data - The data object emitted from CRUD operations.
 * @public
 * @environment server
 */
async function handleCrudEvent(data) {
    if (!data || data.array !== 'cron-job' || !Array.isArray(data.object)) {
        return;
    }

    const updatedJobs = [];

    for (const job of data.object) {
        if (!job || !job._id) continue;

        if (data.method === 'object.delete' || job.active === false) {
            if (scheduledJobs[job._id]) {
                clearTimeout(scheduledJobs[job._id]);
                delete scheduledJobs[job._id];
            }

            job.status = data.method === 'object.delete' ? 'deleted' : 'inactive';
            updatedJobs.push(job);
            continue;
        }

        const nextExecutionTime = getNextExecutionTime(job.schedule);

        if (nextExecutionTime) {
            const timeUntilExecution = new Date(nextExecutionTime) - new Date();
            job.nextExecutionTime = nextExecutionTime;

            if (timeUntilExecution <= 5 * 60 * 1000 && timeUntilExecution >= 0) {
                if (!scheduledJobs[job._id]) {
                    job.status = 'assigned';
                    job.serverId = server?.vmId || server?.serverId || 'default-server';
                    job.workerId = server?.workerId !== undefined ? server.workerId : 'standalone';
                    scheduleCronJob(job);
                }
            } else {
                job.status = 'scheduled';
            }
            updatedJobs.push(job);
        } else {
            job.active = false;
            job.status = 'completed';
            updatedJobs.push(job);
        }
    }

    if (updatedJobs.length > 0) {
        await updateCronJob(updatedJobs);
    }
}

/**
 * Polls the platform DB for cron jobs that are scheduled or potentially failed.
 * @public
 * @environment server
 */
async function pollForCronJobs() {
    if (!crud) return;
    console.log(`[@cocreate/cron] [WORKER ${server?.workerId ?? 'standalone'}] Polling for active organizations' cron jobs...`);

    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
    const oneMinuteAgo = new Date(now.getTime() - 1 * 60 * 1000);

    try {
        const data = await crud.send({
            method: 'object.read',
            array: 'organizations',
            filter: {
                query: {
                    $or: [
                        {
                            $and: [
                                { 'cron-jobs.nextExecutionTime': { $elemMatch: { $lte: fiveMinutesFromNow, $gte: now } } },
                                { 'cron-jobs.status': { $elemMatch: { $ne: 'assigned' } } },
                                { 'cron-jobs.active': { $elemMatch: { $ne: false } } }
                            ]
                        },
                        {
                            $and: [
                                { 'cron-jobs.nextExecutionTime': { $elemMatch: { $lt: oneMinuteAgo } } },
                                { 'cron-jobs.status': { $elemMatch: { $eq: 'assigned' } } },
                                { 'cron-jobs.active': { $elemMatch: { $ne: false } } }
                            ]
                        }
                    ]
                }
            },
            organization_id: process.env.organization_id
        });

        if (!data || !data.object) return;

        for (const org of data.object) {
            const cronJobs = org.cronJobs;
            if (!cronJobs || !Array.isArray(cronJobs)) continue;

            const organizationId = org.organization_id || org._id;
            const jobsToUpdate = [];

            for (const job of cronJobs) {
                if (!job._id || scheduledJobs[job._id]) continue;

                job.status = 'assigned';
                job.clusterId = 'default-cluster';
                job.serverId = server?.vmId || server?.serverId || 'default-server';
                job.workerId = server?.workerId !== undefined ? server.workerId : 'standalone';
                job.organization_id = organizationId;

                scheduleCronJob(job);
                jobsToUpdate.push(job);
            }

            if (jobsToUpdate.length > 0) {
                await updateCronJob(jobsToUpdate);
            }
        }
    } catch (error) {
        console.error('[@cocreate/cron] Error polling for cron jobs:', error);
    }
}

/**
 * Adds a cron job reference to the platform database.
 * @public
 * @environment server
 */
async function addToPlatformDB(organization_id, datetime) {
    if (!crud) return;
    console.log(`[@cocreate/cron] Adding cron job reference to platform DB for org ${organization_id}`);

    try {
        await crud.send({
            method: 'object.read',
            array: 'organizations',
            object: { _id: organization_id, nextCron: datetime },
            organization_id: process.env.organization_id
        });
        console.log(`[@cocreate/cron] Platform DB updated for org ${organization_id}`);
    } catch (error) {
        console.error(`[@cocreate/cron] Error updating platform DB for org ${organization_id}:`, error);
    }
}

/**
 * Finds and schedules the next cron job for the organization after one is executed.
 * @public
 * @environment server
 */
async function findNextCronJob(organization_id) {
    if (!crud) return;
    console.log(`[@cocreate/cron] Finding next cron job for org ${organization_id}`);

    try {
        const nextJob = await crud.send({
            method: 'object.read',
            array: 'cron-job',
            filter: {
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
        console.error(`[@cocreate/cron] Error finding next cron job for org ${organization_id}:`, error);
    }
}

/**
 * Self-Activating Auto-Initialization Loop.
 * @public
 * @environment server
 */
async function init() {
    if (server && server.isInitialized && server.crud && server.wsManager) {
        crud = server.crud;
        wsManager = server.wsManager;

        process.on('crud-event', (event) => {
            handleCrudEvent(event);
        });

        pollForCronJobs();

        setInterval(() => {
            pollForCronJobs();
        }, 5 * 60 * 1000);

    } else {
        setTimeout(init, 500);
    }
}

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

/**
 * A distributed server-side cron scheduler and orchestrator for CoCreate Server.
 *
 * @module cron
 * @environment server
 */
