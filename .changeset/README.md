# Changesets

This folder holds [changesets](https://github.com/changesets/changesets): one markdown
file per user-visible change, describing what changed and how each package's version
should bump.

SPEC.md Appendix E makes this mandatory — a session is not done until it adds a changeset
describing its user-visible change.

```sh
pnpm changeset          # write one
pnpm version-packages   # apply them to package versions
pnpm release            # build and publish
```
