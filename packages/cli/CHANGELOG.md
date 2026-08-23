# @repo/cli

## 0.3.0

## 0.2.4

## 0.2.3

### Patch Changes

- ec6a4cf: `nisi diff <base>..<head>` reviews two branches against each other, neither of which has to be checked out. `a..b` and `a...b` both mean what `head` added since diverging from `base`.
- 22a9c58: `nisi diff <TAB>` now completes branch and tag names, including the head side of a `base..head` or `base...head` range. Run `eval "$(nisi completion zsh)"` in your zsh startup file to enable it.

## 0.2.2

## 0.2.1

### Patch Changes

- 1b6f515: Running `nisi` while the app is already open now brings the window to front and switches to the newly opened tab, instead of leaving both untouched.

## 0.2.0

### Minor Changes

- d24d09c: Initial release
