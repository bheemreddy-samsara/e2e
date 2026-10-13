---
"e2e": patch
---

Preserve discarded hosted video through trace publication with private same-filesystem recovery links. Restore the original inode atomically without copying video bytes, keep complete recovery files when restoration fails, and clean private links without late worker retirement.
