'use client';

import { PageHeader, PageBody } from '@/components/ui';
import { EventsTab } from './events-tab';

export default function TriggerEventsPage() {
  return (
    <>
      <PageHeader title="Trigger events" />
      <PageBody width="wide">
        <EventsTab />
      </PageBody>
    </>
  );
}
