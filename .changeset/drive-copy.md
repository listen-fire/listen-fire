---
"@listen-fire/google-drive": patch
---

Google Drive can copy a file. Write a file along both its destination folder's `Files` edge and the source file's `Copies` edge: `write (folder-[:Files]->, template-[:Copies]->) { Name: "Acme brief" }`. `Name` is optional (Drive names the copy otherwise). The copy is an ordinary file afterwards, so a later write can name it as a parent. The source must be a file the connection was granted (picked, or created by the connection); Drive's refusal is reported as "not granted".
