---
"@repo/desktop": patch
---

Fix Files Changed stuttering and jumping while scrolling. The file-contents query was returning a new Map identity on every render, forcing every visible diff card to rebuild, and placeholder cards (generated, binary, error, and already-reviewed files) were rebuilding their annotation objects each render — discarding the measured heights `@pierre/diffs` relies on to hold your scroll position.
