# PRS.AssetVerify V3

Fixed-asset physical verification for audit fieldwork. Progressive web app —
installs to the home screen, works offline, syncs when the connection returns.

This repository is **completely separate from PRSAV/PRS2**. V2 stays live and
untouched at https://prsav.github.io/PRS2/ for as long as you want it.

## Live

    V2 (production)   https://prsav.github.io/PRS2/
    V3 (this repo)    https://prsav.github.io/PRS3/

## Files

    index.html              app shell and all modals
    app.js                  application logic
    prs-scan.js             V3 scanner engine + GS1 parser
    scan-worker.js          barcode decode Web Worker
    styles.css              V3 interface
    sw.js                   service worker (offline cache)
    manifest.webmanifest    installable app metadata
    icon.svg                app icon

Everything is static. There is no build step — GitHub Pages serves the files
as they are.

## What is separate from V2, and what is not

Separate:

  - This repository, its commits and its history
  - The URL and the service worker scope
  - The service worker cache (`prs-assetverify-v3-root`)
  - The installed app entry ("PRS V3", its own icon)
  - Browser storage. GitHub Pages serves both apps from the same origin
    (prsav.github.io), so storage would otherwise be shared. V3 uses its own
    keys: session `…-v30`, sticky `…-v30-`, IndexedDB `…-offline-v30`.

Shared, on purpose:

  - The Cloudflare Worker, D1 database and R2 photo storage.

Sharing the backend is what lets you migrate gradually: a verification captured
in V3 appears in V2 and the other way round. If you would rather V3 had its own
database entirely, deploy a second Worker with its own D1 and R2 bindings and
change `WORKER_URL` at the top of `app.js`. Note that the two datasets would
then be completely disjoint — you could not switch between them mid-audit.

## Before you switch away from V2

Because the offline queues are now separate, sync V2 before you stop using it.
Open V2 while online and let the pending-sync badge clear. Anything still
queued in V2 will not be picked up by V3.

## Deploying

Push to `main`. GitHub Pages builds automatically.

Settings > Pages > Source: `Deploy from a branch`, branch `main`, folder `/ (root)`.

## Backend

Cloudflare Worker: `pv-capture-ai-v2.mahipal-office21.workers.dev`
Storage: D1 (records, members, roles, fields) and R2 (verification photos).

Both apps are served from `https://prsav.github.io`, so the Worker's CORS
configuration needs no change for V3.
