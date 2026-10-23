# @lf/wake-cloud-tasks

The wake slot on Google Cloud Tasks: when work is due, a Cloud Run job starts to drain it. With it, a webhook's event starts a worker at once, and a parked timer, a poll's next interval or a cron's next fire starts one when it is due, instead of a blind scheduled tick finding them.

Each wake becomes a Cloud Tasks task whose target runs the job (`POST https://run.googleapis.com/v2/<job>:run`). One module fills both hosts' wake slots: lf starts it as a process (`serve.ts`), and the platform imports the wake itself in-process (`@listen-fire/wake-cloud-tasks/cloud_tasks`).

## Install

1. Install `@listen-fire/wake-cloud-tasks` into the project's externals folder and keep `lf-external.yaml` (shipped in the package) beside it, as `externals/wake_cloud_tasks/lf-external.yaml`.
2. Name it in `lf.yaml`:

   ```yaml
   core:
     wake: wake_cloud_tasks
   ```

3. Run `lf connect wake_cloud_tasks` to give it its settings. They go to the project's secrets file (or `LF_SECRET__WAKE_CLOUD_TASKS__<SETTING>` in containers and CI), never into `lf.yaml`.

## Settings

| setting | meaning |
|---|---|
| `queue` | the Cloud Tasks queue: `projects/<project>/locations/<location>/queues/<name>` |
| `job` | the Cloud Run job a task starts: `projects/<project>/locations/<location>/jobs/<name>` |
| `invoker_service_account` | the service account whose OAuth token each task carries to run the job |
| `coalesce_window_ms` | how long one task stands for, in milliseconds. Default `60000`; from `1000` to `3600000` |
| `client_email`, `private_key` | a service account (the key is secret) to call Cloud Tasks as. Leave both empty to use the environment's own Google credentials (a workload identity, `gcloud auth application-default login`) |
| `base_url` | another endpoint speaking Cloud Tasks' REST API (a fake, a proxy); empty for Google's |

## How a wake becomes a task

- **A name per window.** A task is named `<job id>-<window index>`: the job's last segment, and the time divided by `coalesce_window_ms`, rounded down. At the default window the index is the unix minute (`lf-drain-29871234`).
- **"Ready now"** creates this window's task, scheduled now. Cloud Tasks refuses a second task of a name, so a burst of wakes inside one window makes one task.
- **The spent-name follow-on.** Cloud Tasks keeps the name of a task that already ran for about an hour. A "now" whose window's task has run therefore makes the next window's task, scheduled at that window's start, so a wake after a drain is never lost.
- **"Ready at T"** creates the task of the window T closes, scheduled at that window's end: never before T, and at most one window late. A T already past is "ready now".
- **The 30-day limit.** Cloud Tasks schedules at most 30 days ahead. A T further out makes no task and logs one line; the row stays in the store and the safety drain finds it.
- **The task.** An HTTP `POST` to `https://run.googleapis.com/v2/<job>:run` with body `{}` and the invoker's OAuth token (scope `cloud-platform`). OAuth, not OIDC: `run.googleapis.com` is a Google API, and an OIDC token is for a service's own URL. Retries are the queue's.
- `kind` is checked, then ignored: one job drains every kind.

Use the same `coalesce_window_ms` on every process that wakes the same job, so their names agree.

## IAM

- The caller (the accounts of every process that wakes: the serve and the drain job):
  - `roles/cloudtasks.enqueuer` on the queue, to create tasks;
  - `cloudtasks.tasks.get` (`roles/cloudtasks.viewer`), to tell a waiting task from a spent one. Without it a coalesced wake also makes the next window's task, logged once;
  - `iam.serviceAccountUser` on the invoker account, to put its token on a task.
- The invoker: `run.jobs.run` on the job (`roles/run.invoker`).

## The safety net

A failed wake loses no work: the row is already in the store. Keep a scheduled drain every hour to find work whose wake was lost or lay past 30 days.

## Tests

`pnpm test` in this folder runs the wake in-process against the fake Cloud Tasks shipped in this package (`fake_cloud_tasks.ts`, also used by the platform's tests and dev loop), and starts the module as the process lf starts for the wake slot's conformance kit. A generated service account key signs its own tokens, so nothing reaches Google. `apps/cli/src/__test__/wake_cloud_tasks_contract.test.ts` runs the same kit through lf's own client of the module.
