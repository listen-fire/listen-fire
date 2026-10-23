#!/usr/bin/env node
// The process lf starts for the Cloud Tasks wake (lf-external.yaml's
// `command`): it listens where lf says (`MODULE_SOCKET`) and prints the
// `listening …` line lf reads its address from.

import { serveSlot } from 'module-runtime/module-wire';

import { WAKE_CLOUD_TASKS_MANIFEST, wakeCloudTasksAnswer } from './wake_cloud_tasks';

void serveSlot({ manifest: WAKE_CLOUD_TASKS_MANIFEST, answer: wakeCloudTasksAnswer(), print: true });
