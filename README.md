# @cocreate/server-cron

A high-performance, multi-tenant, zero-dependency background cron engine and task scheduler built for distributed cluster orchestration and automated event execution across the CoCreate ecosystem.

---

## Documentation

For complete API references, deployment guides, scheduling examples, and architecture documentation, visit the CoCreate Server Cron documentation:

https://cocreatejs.com/docs/server-cron

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture & Execution Pipeline](#architecture--execution-pipeline)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Schedule Configuration & Formats](#schedule-configuration--formats)
  - [Standard 5-Part Cron Expressions](#1-standard-5-part-cron-expressions)
  - [Rich JSON Schedule Objects](#2-rich-json-schedule-objects)
  - [Supported Schedule Attributes](#supported-schedule-attributes)
- [Cron Expression Parsing Engine](#cron-expression-parsing-engine)
- [Cluster Coordination & Job Assignment](#cluster-coordination--job-assignment)
- [Programmatic API Reference](#programmatic-api-reference)
- [Database Integration & CRUD Events](#database-integration--crud-events)
- [Environment Variables](#environment-variables)
- [Announcements](#announcements)
- [Roadmap](#roadmap)
- [How to Contribute](#how-to-contribute)
- [About](#about)
- [License](#license)

---

# Overview

`@cocreate/server-cron` delivers an enterprise-grade background scheduling engine for `@cocreate/server`.

It supports both traditional 5-part Unix cron expressions and rich JSON schedule objects with advanced scheduling capabilities including time zones, skip dates, end-of-month execution, date ranges, and human-readable scheduling.

Built as a native, zero-dependency service, it combines real-time CRUD event listeners with a resilient polling engine to coordinate scheduled jobs safely across multi-server and multi-worker deployments using atomic job assignment.

---

# Key Features

- **Zero Dependencies** — Built entirely with native Node.js APIs including `Date`, `Intl.DateTimeFormat`, and standard language features.
- **Dual Scheduling Syntax** — Supports traditional cron expressions and structured JSON schedule objects.
- **UTC-First Scheduling** — Performs scheduling calculations in UTC while supporting localized execution using IANA time zones.
- **End-of-Month Support** — Supports `"L"` and `"end-of-month"` keywords, including leap-year awareness.
- **Hybrid Scheduler** — Combines database polling with real-time CRUD event listeners for reliable execution.
- **Cluster Safe** — Coordinates execution using `organization_id`, `clusterId`, `serverId`, and `workerId` ownership to prevent duplicate execution.
- **Integrated Action Routing** — Executes internal server actions, webhooks, or WebSocket broadcasts through the CoCreate platform.

---

# Architecture & Execution Pipeline

The scheduler continuously polls the platform database looking for jobs scheduled within the next five-minute execution window. Eligible jobs are atomically claimed before being scheduled in memory using precise `setTimeout()` timers.

```text
Database / CRUD Event
          │
          ▼
Evaluate Next UTC Execution
          │
          ▼
Is execution within 5 minutes?
          │
     ┌────┴────┐
     │         │
    Yes        No
     │         │
Claim Job      Persist
Schedule       State
setTimeout()
```

When a scheduled timer executes:

```text
Cron Job Triggered
        │
        ▼
Execute Action
(Webhook / WS / Internal Action)
        │
        ▼
Calculate Next Execution Time
        │
   ┌────┴────┐
   │         │
Next Run   Expired
   │         │
Scheduled Completed
```

---

# Installation

## NPM

```bash
npm install @cocreate/server-cron
```

## Yarn

```bash
yarn add @cocreate/server-cron
```

> **Note**
>
> When used alongside `@cocreate/server`, the cron service initializes automatically.

---

# Quick Start

## Calculate the Next Execution Time

```javascript
import cronJobs from "@cocreate/server-cron";

const nextRun = cronJobs.getNextExecutionTime({
	cronExpression: "0 8 * * 1-5",
	timezone: "UTC"
});

console.log(nextRun);
```

## Create a Scheduled Job

```javascript
await crud.send({
	method: "object.create",
	array: "cron-job",
	organization_id: "org_102938",
	object: [
		{
			organization_id: "org_102938",
			action: "notifications.sendDigest",
			active: true,
			schedule: {
				time: "09:00:00",
				daysOfWeek: ["Monday", "Wednesday", "Friday"],
				skipDates: ["2026-12-25"],
				timezone: "America/New_York"
			}
		}
	]
});
```

---

# Schedule Configuration & Formats

The scheduler accepts either a standard cron expression or a structured JSON schedule object.

## 1. Standard 5-Part Cron Expressions

```json
{
	"cronExpression": "*/15 8-17 * * MON-FRI",
	"startTime": "2026-01-01T00:00:00.000Z",
	"endTime": "2026-12-31T23:59:59.000Z",
	"skipDates": ["2026-07-04"]
}
```

---

## 2. Rich JSON Schedule Objects

```json
{
	"startTime": "2026-01-01T00:00:00.000Z",
	"endTime": "2026-12-31T23:59:59.000Z",
	"time": "14:30:00",
	"daysOfWeek": ["Tuesday", "Thursday"],
	"daysOfMonth": [1, 15, "L"],
	"months": ["January", "June", "December"],
	"skipDates": ["2026-11-26"],
	"timezone": "UTC"
}
```

---

## Supported Schedule Attributes

| Property | Type | Description |
|----------|------|-------------|
| `cronExpression` | String | Standard 5-part cron expression. |
| `startTime` | String | Earliest execution time. |
| `endTime` | String | Expiration time. |
| `time` | String | Time of day (`HH:MM` or `HH:MM:SS`). |
| `daysOfWeek` | Array | Weekday names. |
| `daysOfMonth` | Array | Month days including `"L"` or `"end-of-month"`. |
| `endOfMonth` | Boolean | Execute only on the last day of the month. |
| `months` | Array | Month names. |
| `skipDates` | Array | ISO dates excluded from execution. |
| `timezone` | String | IANA timezone identifier. Defaults to `UTC`. |

---

# Cron Expression Parsing Engine

Supported fields:

```text
Minute Hour Day-of-Month Month Day-of-Week
```

Supported syntax:

| Syntax | Example | Description |
|---------|---------|-------------|
| Wildcard | `*` | Every value |
| Value | `15` | Specific value |
| List | `1,15,30` | Multiple values |
| Range | `1-5` | Inclusive range |
| Step | `*/15` | Every N values |
| Aliases | `JAN`, `MON` | Month and weekday aliases |

---

# Cluster Coordination & Job Assignment

To prevent duplicate execution, scheduled jobs are atomically assigned to a server and worker before execution.

Example assignment:

```json
{
	"status": "assigned",
	"clusterId": "default-cluster",
	"serverId": "srv_instance_84f92a",
	"workerId": 2,
	"organization_id": "org_30192"
}
```

If a worker exits before execution completes, polling automatically detects stale assignments and safely reassigns work to another available worker.

---

# Programmatic API Reference

## getNextExecutionTime(schedule)

Calculates the next execution time.

```javascript
import cronJobs from "@cocreate/server-cron";

const next = cronJobs.getNextExecutionTime({
	cronExpression: "0 0 * * *"
});
```

---

## scheduleCronJob(job)

Schedules a job in memory.

```javascript
cronJobs.scheduleCronJob({
	_id: "job_88a91b",
	organization_id: "org_102",
	nextExecutionTime: "2026-08-01T12:00:00.000Z",
	schedule: {}
});
```

---

## executeCronJob(job)

Immediately executes a scheduled job.

```javascript
await cronJobs.executeCronJob(jobObject);
```

---

## pollForCronJobs()

Scans the database for pending work.

```javascript
await cronJobs.pollForCronJobs();
```

---

## handleCrudEvent(data)

Updates in-memory schedules after CRUD operations.

```javascript
process.emit("crud-event", {
	array: "cron-job",
	method: "object.update",
	object: [updatedJob]
});
```

---

# Database Integration & CRUD Events

`@cocreate/server-cron` automatically listens for platform CRUD events using:

```javascript
process.on("crud-event");
```

### Supported Events

| Event | Behavior |
|--------|----------|
| `object.create` | Calculates next execution time and schedules the job. |
| `object.update` | Recalculates the schedule and updates timers. |
| `object.delete` | Cancels timers and releases resources. |
| `active: false` | Stops scheduling and marks the job inactive. |

Organization updates also synchronize job summaries into the parent `organizations` collection.

---

# Environment Variables

| Variable | Default | Description |
|----------|----------|-------------|
| `organization_id` | — | Platform administrative organization. |
| `SERVER_ID` | `default-server` | Unique server identifier. |
| `WORKER_ID` | `standalone` | Worker process identifier. |

---

# Announcements

Release notes, performance improvements, scheduling enhancements, and compatibility updates are available on the GitHub Releases page:

https://github.com/CoCreate-app/CoCreate-server-cron/releases

---

# Roadmap

Upcoming improvements include:

- Runtime AST execution rules
- Distributed lock providers
- Built-in execution telemetry
- Retry policies with exponential backoff
- Enhanced monitoring and reporting

---

# How to Contribute

We welcome bug reports, feature requests, documentation improvements, and pull requests.

Please review the contributing guide before submitting changes:

- **Contributing Guide:** https://github.com/CoCreate-app/CoCreate-server-cron/blob/master/CONTRIBUTING.md
- **Issue Tracker:** https://github.com/CoCreate-app/CoCreate-server-cron/issues
- **Discussions:** https://github.com/CoCreate-app/CoCreate-server-cron/discussions

---

# About

`@cocreate/server-cron` is designed, built, and maintained by the CoCreate Developer Experience Team.

It provides the distributed scheduling and recurring task execution backbone for the CoCreate platform.

Learn more:

- Documentation: https://cocreatejs.com/docs/server-cron
- Website: https://cocreatejs.com

---

# License

This software is dual-licensed under the GNU Affero General Public License v3 (AGPLv3) and a commercial license.

### Open Source

For open-source and non-commercial projects, this software is available under the AGPLv3.

See the `LICENSE` file for details.

### Commercial

Organizations requiring proprietary use without AGPL obligations may obtain a commercial license from CoCreate.

https://cocreatejs.com/licenses