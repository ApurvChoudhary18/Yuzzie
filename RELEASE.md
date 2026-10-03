# Releasing Yuzie

Releases are cut by [changesets](https://github.com/changesets/changesets) in
`.github/workflows/release.yml`.

Every package is versioned together: `@yuzie/*` and the unscoped `yuzie` alias form one fixed
group in `.changeset/config.json`. The published set is:
- the libraries: `@yuzie/core`, `@yuzie/store`, `@yuzie/sdk`, `@yuzie/git`, `@yuzie/mcp`,
  `@yuzie/server`;
- the CLI, `@yuzie/cli`;
- `yuzie`, the alias that makes `npx yuzie` work;
- the server image, `ghcr.io/apurvchoudhary18/yuzie-server`.

`CHANGELOG.md` files are generated per package from the changesets. Don't edit them by hand.

## Once: turning releases on

The release workflow does nothing until these are done. Publishing can't be undone, so each
step is a deliberate choice.

1. **Names.** Check that the npm scope `@yuzie` and the package name `yuzie` are available, or
   owned by you. If they aren't, rename them in every `package.json`, in
   `.changeset/config.json` and in these docs.
2. **npm credentials.** Use one of:
   - **A token**, for the first release: a granular access token with read and write access
     to the `yuzie` org's packages and "bypass two-factor authentication" ticked, stored as
     the repository secret `NPM_TOKEN` (`gh secret set NPM_TOKEN`). npm only lets you set up
     trusted publishing on a package that already exists, so the first publish needs a token.
   - **Trusted publishing**, from the second release on (preferred): on npmjs.com, for each
     package, add this repository and `release.yml` as a trusted publisher. Then delete the
     `NPM_TOKEN` secret and revoke the token.
   - The `@yuzie/*` packages need the npm organisation `yuzie` to exist, with you as an owner.
     The unscoped `yuzie` package does not.
3. **GHCR.** Nothing to do: the workflow publishes with its own `GITHUB_TOKEN`. After the first
   push, make the package public: GitHub → Packages → `yuzie-server` → Package settings.
4. **Switch it on.** Set the repository variable `RELEASES_ENABLED` to `true`: Settings →
   Secrets and variables → Actions → Variables.

## Every release

1. **Changesets.** Every user-visible change merged since the last release has a changeset
   (`pnpm changeset`).
2. **Green main.** All four `verify` legs, `packages` and `release-acceptance` are green on
   `main`. `release-acceptance` covers two things:
   - it follows `docs/self-hosting.md` verbatim and runs e2e against the result;
   - it runs `npx yuzie@latest init` through Journey A on a clean container, from packed
     tarballs.
3. **The version pull request.** With changesets pending, the release workflow keeps a
   `Release: version packages` pull request open. Review:
   - the version bump (one number for everything);
   - the generated `CHANGELOG.md` entries — rewrite a changeset if its entry reads badly;
   - that `docs/commands.md` is current (CI checks it against `--help`).
4. **Merge it.** The workflow then:
   - checks the exports again (`scripts/check-packages.mjs`);
   - publishes every package to npm with provenance;
   - tags the release and creates GitHub releases;
   - builds the server image for amd64 and arm64, pushes it to GHCR as `:<version>` and
     `:latest`, and attests it.
5. **Check what shipped.**
   ```console
   $ npm view yuzie version
   $ npx yuzie@latest --version
   $ docker pull ghcr.io/apurvchoudhary18/yuzie-server:latest
   ```
   The npm page of each package shows a provenance badge linking back to the workflow run.
6. **Announce.** Copy the release notes from the GitHub release.

## If something goes wrong

- **A publish failed partway.** Re-run the workflow. `changeset publish` skips versions that
  are already on npm.
- **A bad version went out.** Don't unpublish. Publish a fix. For a serious bug, deprecate the
  version: `npm deprecate yuzie@x.y.z "…"`, and the same for `@yuzie/cli@x.y.z`.
- **A dry run.** `pnpm changeset version` locally shows exactly what would be bumped. Don't
  commit its result.
