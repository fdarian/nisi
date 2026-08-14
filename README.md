# nisi

**A simpler way to review code.**

<img width="2216" height="1450" alt="CleanShot 2026-08-09 at 18 46 53@2x" src="https://github.com/user-attachments/assets/3f176c9f-4cf0-4619-90b5-c7556b289f5c" />

---

**What’s unique about nisi**:
- <details><summary> Re-review only what changed since you last looked. — Every other tool resets 400 lines of a reviewed file when you only added one nit. nisi snapshots your review and diffs from there.</summary>
   
   https://github.com/user-attachments/assets/8f14be35-15bf-4a83-9e25-9d5bc8caacd0

   </details> 
- <details><summary> [Soon] Generated walkthrough — Understand changes, not files. Walkthrough will group related changes (per-hunks not just file) so the diff arrives explained and in reading order, every claim linked to the lines it's about.</summary>


   > This feature is still unstable, you can enable it in the settings
   
   https://github.com/user-attachments/assets/4ca1be20-891a-4f62-8f2b-9c9468c80e76

  </details>

**With the essentials**:
- <details><summary> Open with CLI — Run `nisi` anywhere in your repo to **review PR or compare diffs</summary>
   
   https://github.com/user-attachments/assets/1c0d96ec-0e86-4086-bf3a-70a0b5cb1ca3

  </details>
- **Fast, and fully local** — Built with [Tauri](https://tauri.app/), `gh`, and SQLite
- *[Soon]* **Bring your own harness** — Use your existing agents and subscription

More on [features section](#features)

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

## Features

- Handy, vim-like, keymaps:
   - <details><summary>j/k to navigate between files;  r to mark reviewed, u to undo last reviewed</summary>
     
     https://github.com/user-attachments/assets/a48f47ca-7b33-45e6-903a-1c1536480035
   
    </details>
    
   - <details><summary> / to search keyword and ⌘+f for files. n/N to focus on the next/previous match</summary> 
     
     https://github.com/user-attachments/assets/e740fe41-a73b-423d-9ab3-a3369390f278
   
    </details>
    
- <details><summary>Include uncommitted changes, see new diffs in real-time</summary>
   
   https://github.com/user-attachments/assets/1192bbe0-eee3-4260-8d48-ba12ce9ff3df
  
   </details>

## Acknowledgements
- [pierre diffs](https://diffs.com/) for awesome diff library to make this happen
- [codiff](https://github.com/nkzw-tech/codiff) and [Linear](https://linear.app/docs/diffs) for leading this movement

## License

[Apache-2.0](LICENSE)
