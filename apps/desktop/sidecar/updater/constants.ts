/**
 * The Homebrew cask token and the tap that owns it — `fdarian/tap`
 * (`fdarian/homebrew-tap`), `Casks/nisi.rb`, rendered by
 * `scripts/update-homebrew-cask.ts`'s `renderCask`. Shared by `homebrew.ts`
 * (`brew list`/`brew fetch --cask nisi`) and `restart-helper.ts` (the
 * restart script's `brew upgrade --cask nisi`) so the token exists in
 * exactly one place.
 */
export const CASK_TOKEN = "nisi";

/**
 * Verified on the dev machine: `/Applications/nisi.app` is a real directory
 * (the Caskroom entry is a symlink pointing *at* it, not the reverse), so
 * this is both what `brew upgrade --cask nisi` overwrites in place and what
 * the restart helper relaunches with `open -a`. Only ever meaningful once
 * `homebrew.ts`'s probe has already confirmed a real cask install — nothing
 * here falls back to a locally-built dev bundle the way `packages/cli`'s app
 * launcher does, since a non-Homebrew install is out of scope for this
 * feature entirely.
 */
export const APP_BUNDLE_PATH = "/Applications/nisi.app";
