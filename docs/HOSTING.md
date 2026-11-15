# Hosting and redundancy

SkyShift does not depend on the owner's computer, and it is built so that no single host is essential.

## What already keeps working without any extra account

| Failure | What still works |
|---|---|
| The owner's computer is off | Everything: GitHub Actions builds, refreshes (every 6 hours) and deploys; GitHub Pages serves. |
| GitHub Pages is down | Installed copies (and any browser that opened SkyShift before) start from their offline copy: the app, help, the challenge targets' image lists, and every field already viewed (its images and overlays included). New images still stream for those fields, because pixels come from NASA IRSA's cloud bucket, not from GitHub. |
| No archive relay available | Searching any position (static image index, rebuilt every 6 hours), the overlays for the five challenge targets (built-in Gaia DR3 and CatWISE2020 lists), Live, Mission and the Sky atlas images. Only overlays for other positions, Gaia ID look-ups, NEOSSat listings and the live source checks need a relay, and the app says so. Without a relay, images are read row by row (slower) and asteroids and comets can be followed only from the user's own table (looking them up by name needs the relay). |

## Live backup

**Cloudflare Pages: https://skyshift-spherex.pages.dev/** (set up 2026-11-14). Every run of the GitHub workflow uploads
the identical build there, image index included, using the repository secrets `CLOUDFLARE_API_TOKEN` (an API token
limited to *Cloudflare Pages: Edit*) and `CLOUDFLARE_ACCOUNT_ID`; no Cloudflare app is installed on GitHub. Cloudflare
runs SkyShift's relay at `/api/relay`, so live search and every overlay work there, and the GitHub Pages copy uses that
relay too (repository variables `RELAY_URLS` and `MIRROR_URLS`). Cloudflare keeps serving the last upload if GitHub is down.

## Adding more backup hosts (needs a free account with each host, created by the owner)

Each further host below builds the same repository with the configuration files already in it, serves the full app, and runs
its own relay at `/api/relay` (so search and all overlays work live there). Once imported, each keeps serving its last
build even when GitHub is down. Any one of them is enough; two give more redundancy.

| Host | One-time setup by the owner | Files already in the repository |
|---|---|---|
| Cloudflare Pages | Already live (above): deployed by the workflow with the repository secrets, no Git connection needed | `functions/api/relay.js`, `relay/core.mjs` |
| Netlify | Add new site → Import an existing project → GitHub → `skyshift-spherex` (settings are read from `netlify.toml`) | `netlify.toml`, `netlify/edge-functions/relay.js` |
| Vercel | Add New → Project → Import `skyshift-spherex` (settings are read from `vercel.json`) | `vercel.json`, `api/relay.js` |

`wrangler.toml` also defines a stand-alone relay Worker (`npx wrangler deploy`) with its own 6-hourly schedule.

## Telling the GitHub Pages copy about the backups

In the GitHub repository: Settings → Secrets and variables → Actions → Variables, add

- `RELAY_URLS`: the backup relays, comma-separated, e.g. `https://skyshift-spherex.pages.dev/api/relay,https://skyshift-spherex.netlify.app/api/relay`
- `MIRROR_URLS`: the backup sites, comma-separated, e.g. `https://skyshift-spherex.pages.dev,https://skyshift-spherex.netlify.app`

The next deploy writes them into the shipped `config.json` (`scripts/build.mjs`): the GitHub Pages copy then uses the
backup relays for live overlays (it tries each in turn and remembers the first that answers), and the About page lists
the mirrors. No code change is needed.

## Keeping a copy of the code outside GitHub

The repository is public, so it can also be archived permanently by the Software Heritage archive
(https://archive.softwareheritage.org/save/) or mirrored to another Git host. Both are owner decisions and are not done
automatically.

## Relay features (2026-11-15)

- **Gather**: `?gather=<SPHEREx file>&r=<start-end,...>` reads the image rows of one exposure near IRSA's bucket in a few
  large reads and returns only the requested bytes, so a browser makes one request per exposure instead of about 100
  (limits: 600 ranges, 6 MB asked, 8 reads of at most 24 MB; only files of the public SPHEREx bucket).
- **NASA JPL Horizons** is on the allow-list (`/api/horizons.api`) for asteroid and comet positions by name.
- **Smart Placement** (optional): in the Cloudflare dashboard, Pages project → Settings → Functions → Placement → Smart
  would run the relay near IRSA's bucket (us-east-1) and shorten the first frame of fields without ready-made frames.
