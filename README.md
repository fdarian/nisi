# nisi

**A simpler way to review code.**

<!-- TODO: demo video -->

**What’s unique about nisi**:
- **Re-review only what changed since you last looked.** — Every other tool resets 400 lines of a reviewed file when you only added one nit. nisi snapshots your review and diffs from there.
- *[Soon]* **Generated walkthrough** — Understand changes, not files. Walkthrough will group related changes (per-hunks not just file) so the diff arrives explained and in reading order, every claim linked to the lines it's about.

**With the essentials**:
- **Open with CLI** — Run `nisi` anywhere in your repo to **review PR** or **compare diffs**
- **Fast, and fully local** — Built with [Tauri](https://tauri.app/), `gh`, and SQLite
- *[Soon]* **Bring your own harness** — Use your existing agents and subscription

See [the complete features](#complete-features)

<details>
<summary> A bit about the motivation </summary>

As AI generate code faster, and (arguably) better, the bottleneck is on us to review. I believe we should still understand the code, because our subconscious (taste, vision) is what distinguishes humans with AI and one person to another. Just like we don’t need to write machine-level code (python is much simpler than assembly), we need to lift the abstraction so we see code in a different perspective that’s simpler.

I made this app because I wanted to have the feature in my own direction, because some apps have its own limitation and its own use. nisi will always be local, handy, and interoperable.
</details>

## Install

Apple Silicon only, for now — the release build is arm64.
1. **Install with homebrew**

   ```sh
   brew install --cask fdarian/tap/nisi
   ```

   > ⚠️ nisi isn't signed with an Apple Developer ID yet, so Gatekeeper blocks the first 	launch. Clear it once:
   > ```sh
   > xattr -dr com.apple.quarantine /Applications/nisi.app
   > ```

2. **Make sure `gh` CLI is installed and authenticated**
   Check their [site](https://cli.github.com) for the installation, and authenticate with (`gh auth login`).
   nisi shells out to `gh` to find the PR for your branch, and opening one fails without it.

## Usage
The recommended way to use nisi is to use the CLI:
```sh
nisi
# Opens the current branch's PR in the app. No open PR? Diffs against the
# repo's default branch instead.

nisi /path/to/other/repo
# Point at a different repo without cd-ing there first.
```

You can also open a PR from app directly, you’ll be prompted for the folder where the branch will be cloned (it can reuse existing checkout).

## Complete Features
*Non-exhaustive*
- Handy, vim-like, keymaps:
  - `j`/`k` to navigate between files
  - `r` to mark reviewed, `u` to undo last reviewed
  - `/` to search keyword and `cmd+f` for files. `n`/`N` to focus on the next/previous match
- Include uncommitted changes, see new diffs in real-time

## Acknowledgements
- [pierre diffs](https://diffs.com/) for awesome diff library to make this happen
- [codiff](https://github.com/nkzw-tech/codiff) and [Linear](https://linear.app/docs/diffs) for leading this movement

## License

[Apache-2.0](LICENSE)
