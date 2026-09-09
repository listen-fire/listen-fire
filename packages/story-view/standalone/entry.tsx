import { createRoot } from "react-dom/client";

import { StoryPage } from "./page";
import type { StoryView } from "../view";

/**
 * The standalone bundle's entry: read the view the server inlined, draw it.
 *
 * The page fetches nothing. Everything it needs was projected server-side and
 * written into the document, so the link works with no session, no API call
 * and no second round trip — which is what makes it safe to hand to someone
 * who has never heard of us.
 */
const DATA_ID = "story-view-data";
const ROOT_ID = "story-root";

const data = document.getElementById(DATA_ID)?.textContent;
const root = document.getElementById(ROOT_ID);

if (data && root) {
  createRoot(root).render(<StoryPage view={JSON.parse(data) as StoryView} />);
}
