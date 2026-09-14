# Project cover

The cover shows the real Projects view with synthetic projects in the isolated development workspace. The capture builds the application, prepares a fresh local D1 database, creates sample projects through the command API, and waits for live updates and fonts before rendering at 1440 x 1000 in the dark theme. No provider observations or production workspace data are used.

```sh
npm ci
npx playwright install chromium
npm run capture:cover
```

The command owns a temporary database and local server, which it removes when finished. It replaces `HQ_E2E_STATE` internally so it cannot reset an existing development or test workspace.

CI regenerates this image from source during verification and uploads it for review. On `main`, a changed cover opens a pull request with automatic merging after the repository's required checks pass. Verification is dispatched explicitly for the generated branch. Pull request builds never publish another cover update, and superseded builds leave publication to the newer source commit.

In repository settings, enable **Allow auto-merge** and **Allow GitHub Actions to create and approve pull requests**. The workflow only creates pull requests; it does not approve reviews or bypass branch protection. Its write permissions are confined to the publication job. Scheduled and manual workflow runs can refresh the image without an application change.
