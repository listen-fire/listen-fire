// The movements list merged into `/automations` (2026-06-11) — this
// route survives only as a redirect so old links keep working. The
// editor routes (`/movements/new`, `/movements/[id]`) remain.

import { redirect } from "next/navigation";

export default function MovementsPage() {
  redirect("/automations");
}
