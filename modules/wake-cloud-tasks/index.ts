// @lf/wake-cloud-tasks: the wake slot's module on Google Cloud Tasks.
// `serve.ts` is the process lf starts; `cloud_tasks.ts` is the wake itself,
// which a host may also import in-process.

export * from './cloud_tasks';
export * from './wake_cloud_tasks';
