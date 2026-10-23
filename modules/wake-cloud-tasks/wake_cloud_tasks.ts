// @lf/wake-cloud-tasks: the wake slot (docs/contracts/wake-slot.md) on
// Google Cloud Tasks. Each wake becomes a task named for its coalescing
// window that starts a Cloud Run drain job (cloud_tasks.ts); this is the
// slot's wire face. `kind` is validated, then ignored: one job drains every
// kind.

import { WAKE_METHODS, WakeAtRequest, WakeNowRequest, type WireSlotManifestShape } from 'engine-contracts/slots';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module-wire';

import { CloudTasksError, CloudTasksWake, WakeSettingError, readInstall } from './cloud_tasks';

export const WAKE_CLOUD_TASKS_MANIFEST: WireSlotManifestShape = { protocolVersion: 2, name: 'wake_cloud_tasks', kind: 'core', slot: 'wake', methods: [...WAKE_METHODS] };

function badRequest(method: string, issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): SlotRefusal {
  return new SlotRefusal('bad_request', `${method}: ${issues.map((issue) => `${issue.path.map(String).join('.') || 'request'}: ${issue.message}`).join('; ')}`);
}

/** The slot's answers, reading the install once per distinct settings (lf
 *  carries them on every request). */
export function wakeCloudTasksAnswer(): SlotAnswer {
  const installs = new Map<string, CloudTasksWake>();
  const wakeOf = (settings: Record<string, unknown>): CloudTasksWake => {
    const id = JSON.stringify(settings);
    let wake = installs.get(id);
    if (wake === undefined) {
      wake = new CloudTasksWake(readInstall(settings));
      installs.set(id, wake);
    }
    return wake;
  };
  const arranged = async (settings: Record<string, unknown>, wake: (to: CloudTasksWake) => Promise<void>): Promise<null> => {
    try {
      await wake(wakeOf(settings));
      return null;
    } catch (error) {
      if (error instanceof WakeSettingError) throw new SlotRefusal(error.code, `${error.message}: run \`lf connect wake_cloud_tasks\``);
      if (error instanceof CloudTasksError) throw new SlotRefusal('module_error', error.message);
      throw error;
    }
  };
  return async (method, params, settings) => {
    switch (method) {
      case 'wake.now': {
        const request = WakeNowRequest.safeParse(params);
        if (!request.success) throw badRequest(method, request.error.issues);
        return arranged(settings, (wake) => wake.now(request.data.kind));
      }
      case 'wake.at': {
        const request = WakeAtRequest.safeParse(params);
        if (!request.success) throw badRequest(method, request.error.issues);
        return arranged(settings, (wake) => wake.at(request.data.kind, new Date(request.data.at)));
      }
      default:
        throw new SlotRefusal('method_not_implemented', `no method "${method}"`);
    }
  };
}
