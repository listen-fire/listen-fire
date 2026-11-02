---
"@listen-fire/web": patch
---

`linkedin-research` reads the profile when its headline is a placeholder ("Stealth", "Stealth Startup", "Self-employed", "Independent", "Freelance"), the same as when there is no headline. Before, a placeholder counted as a role, so the profile was never read and the search ran on the bare name, which finds namesakes. The query planner now sees the profile text and searches on the person's founder history. A run that read the profile is no longer capped at low confidence. For a stealth founder, the summary leads with their previous venture, and `current_organisation` names it as a likely guess. The general `research` plugin reads profiles through the same rule, so it reads stealth profiles too.
