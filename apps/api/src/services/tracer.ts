import { TeamId } from '../generated/kysely/core/Team';
import { getQb } from '../lib/kysely';
import { currentContext } from './context';

export class Tracer {
  values: Record<string, unknown> = {};
  parent?: Tracer;
  name: string;
  children: Tracer[] = [];

  constructor(name?: string) {
    this.name = name ?? 'root';
  }

  child(name: string): Tracer {
    const tracer = new Tracer(name);
    tracer.parent = this;
    this.children.push(tracer);
    return tracer;
  }

  add(key: string, value: unknown) {
    this.values[key] = value;
  }

  toString(): string {
    return JSON.stringify(this.flatten());
  }

  flatten(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    let tracer: Tracer | undefined = this;
    while (tracer) {
      values[tracer.name] = tracer.values;
      tracer = tracer.parent;
    }
    return values;
  }

  flattenDown(isRoot?: boolean): Record<string, unknown> {
    let values: Record<string, unknown> = {};
    if (isRoot) {
      values[this.name] = this.values;
    } else {
      values = { ...this.values };
    }

    for (const child of this.children) {
      const existing = values[child.name];
      if (existing && Array.isArray(existing)) {
        values[child.name] = [...existing, child.flattenDown()];
      } else {
        values[child.name] = [child.flattenDown()];
      }
    }

    return values;
  }

  async span<T>(fn: (span: Tracer) => Promise<T>): Promise<T> {
    try {
      return await fn(this);
    } catch (error) {
      if (error instanceof Error) {
        // @ts-ignore - attaching trace to error
        if (!error.trace) {
          // @ts-ignore
          error.trace = this.flatten();
        }
      }
      throw error;
    }
  }

  async writeToContextLogs(key: string) {
    const ctx = currentContext();
    const values: Record<string, unknown> = {};
    const flattened = this.flattenDown(true);
    for (const [key, value] of Object.entries(flattened)) {
      values[key] = value;
    }

    await getQb(['context_logs'])
      .insertInto('context_logs')
      .values({
        key,
        value: values,
        team_id: ctx.user.teamId as TeamId,
        request_id: ctx.id,
      })
      .execute();
  }
}
