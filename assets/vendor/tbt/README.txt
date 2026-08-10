Bundled fallback copies of the TBT-Hub shared stylesheets.

Source of truth: the TBT-Hub plugin (assets/css/tbt-tokens.css and
assets/css/tbt-components.css, Style Spec v2.1). These copies are NEVER
enqueued when Hub is active — TBT_Notes_Frontend::ensure_shared_styles()
registers them under the SAME handles ('tbt-tokens' / 'tbt-components')
only when Hub has not registered them, and raises an admin notice when it
does so. There is never a second copy under a different handle.

Refresh these files whenever TBT-Hub bumps the shared stylesheets.
