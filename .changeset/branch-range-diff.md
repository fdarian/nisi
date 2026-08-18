---
"@repo/desktop": patch
"@repo/cli": patch
---

`nisi diff <base>..<head>` reviews two branches against each other, neither of which has to be checked out. `a..b` and `a...b` both mean what `head` added since diverging from `base`.
