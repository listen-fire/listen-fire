import { Router } from 'express';
import type { EntityStore } from '../store';
import { seedDefaults } from '../seed';

const SERVICES = ['affinity', 'attio', 'slack', 'sheets', 'airtable', 'granola', 'evertrace', 'webhook', 'whatsapp', 'gdrive', 'dropbox'];

export function adminRoutes(store: EntityStore): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Get all state for a service
  r.get('/:service/state', (req, res) => {
    const { service } = req.params;
    if (!SERVICES.includes(service)) return res.status(400).json({ error: `Unknown service: ${service}` });
    const entities = store.listAll(service);
    const grouped: Record<string, unknown[]> = {};
    for (const e of entities) {
      if (!grouped[e.entity_type]) grouped[e.entity_type] = [];
      grouped[e.entity_type].push({ id: e.id, ...e.data });
    }
    res.json(grouped);
  });

  // Get state for a specific entity type
  r.get('/:service/:entityType/state', (req, res) => {
    const entities = store.list(req.params.service, req.params.entityType);
    res.json(entities.map((e) => ({ id: e.id, ...e.data })));
  });

  // Delete all state for a service then re-seed defaults
  r.delete('/:service/state', (req, res) => {
    const { service } = req.params;
    if (!SERVICES.includes(service)) return res.status(400).json({ error: `Unknown service: ${service}` });
    store.deleteService(service);
    seedDefaults(store);
    res.json({ ok: true, service });
  });

  // Delete all state then re-seed defaults
  r.delete('/all', (_req, res) => {
    store.deleteAll();
    seedDefaults(store);
    res.json({ ok: true });
  });

  // Seed data for a service
  r.post('/:service/seed', (req, res) => {
    const { service } = req.params;
    const entities = req.body.entities as { entity_type: string; id?: string; data: Record<string, unknown> }[];
    if (!Array.isArray(entities)) return res.status(400).json({ error: 'Expected { entities: [...] }' });

    for (const e of entities) {
      store.create(service, e.entity_type, e.data, e.id);
    }
    res.json({ ok: true, count: entities.length });
  });

  return r;
}
