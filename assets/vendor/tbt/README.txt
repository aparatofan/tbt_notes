Bundled fallback copies of the TBT-Hub shared stylesheets.

Source of truth: the TBT-Hub plugin (assets/css/tbt-tokens.css and
assets/css/tbt-components.css, Style Spec v2.1). These copies are NEVER
enqueued when Hub is active — TBT_Notes_Frontend::ensure_shared_styles()
registers them under the SAME handles ('tbt-tokens' / 'tbt-components')
only when Hub has not registered them, and raises an admin notice when it
does so. There is never a second copy under a different handle.

Refresh these files whenever TBT-Hub bumps the shared stylesheets.

PENDING HUB CHANGES
-------------------
These copies currently run AHEAD of TBT-Hub. Both changes were approved for
the suite, not just for Notes, and have no effect on a site where Hub is
active until Hub adopts them:

  tbt-components.css  .tbt-tool-hero__title  34px -> 40px
  tbt-tokens.css      --tbt-deco-teal #008080, --tbt-deco-coral #FF6B6B
                      (decorative palette; never state or danger colours)

Both need a TBT-STYLE-SPEC.md version bump: §3 records the hero title at
34px, and §2 lists the approved token groups. Delete this section once Hub
has them.
