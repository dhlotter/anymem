# Backups and restore

There are four layers. The first two run without you. A backup protects you from a bad write or a wrong delete. The R2 bucket sits in the same Cloudflare account as the database, so it does not protect you from losing the account. Pull a local copy if you want one elsewhere.

## 1. The nightly copy to R2

Every night at 01:00 UTC the Worker's maintenance run writes the whole store to the R2 bucket `NAME-backups` as `backups/anymem-YYYY-MM-DD.json.gz`, using the UTC date. Setup gives the bucket a rule that deletes objects under `backups/` after 30 days. Nothing runs on your machine.

1. **What is in it.** Export format 2. Every memory with its raw columns and tags, the trash and closed memories included. Every version. The model written question keys. Every link and every rejected link. Every subject row (its slug, kind, status, scope, fields and aliases, the three brief columns `member_hash`, `built_at` and `stale_reason`, and the id of its card memory, which is an ordinary memory in the same document). Every device with its token hash, never a token, and its `allow_private` flag, which says whether the device may see private subjects. Search keys and vectors are not in it, so a restore rebuilds them.
2. **A shrunken backup is refused.** If today's export has fewer than 80 percent of the entries of the newest backup already in the bucket, nothing is written, the old backup stays, and the nightly run is recorded as failed. The memories that the trash purge removed since that backup are allowed for, so a purge alone never refuses a backup. Forcing a backup past the check (`POST /backup/run` with `force: true`) skips it, for when the drop is real and wanted.
3. **Routes.** `GET /backup` lists the backups newest first with their day, size and entry count. `GET /backup/DAY` downloads the gzip. `POST /backup/run` takes today's backup now, and `{"force": true}` skips the size check. All three need the admin token, and the first two also accept a browser login.
4. **Visibility.** `doctor.py` prints the latest backup and warns when it is more than 2 days old or when the Worker has no bucket. The dashboard's Health screen lists the backups with a download link.

## 2. D1 Time Travel

Cloudflare keeps a point in time history of a D1 database. As Cloudflare's documentation read on 2026-10-16, you can restore the database to any minute in the last 7 days on the Free plan or 30 days on Paid, and a restore returns a bookmark so it can be undone. It is separate from the R2 backups. Anymem does not drive it. Setup does not record a bookmark before an upgrade, so note one yourself before you change a database you care about. Restore from the Cloudflare dashboard or API, following Cloudflare's D1 documentation.

## 3. A local copy

```bash
backup.py
backup.py --dir ~/backups/anymem --keep 60 --markdown ~/memory-notes
backup.py --from-worker --now
```

| Flag | Meaning | Default |
|---|---|---|
| `--dir DIR` | Backup folder | `backups/` in the config folder |
| `--keep DAYS` | Delete copies older than this | 30 |
| `--from-worker` | Download the Worker's latest R2 backup instead of taking a fresh export. Needs the admin token | off |
| `--now` | With `--from-worker`, have the Worker take today's backup first | off |
| `--markdown DIR` | Also write one markdown file per live memory, named by its frontmatter name, for reading. Files are added or rewritten, never deleted | off |
| `--quiet` | Print nothing on success | off |

By default it takes a fresh `GET /export`, paged 1,000 memories at a time by cursor, so a purge between two pages cannot shift one. It writes `anymem-YYYY-MM-DD.json.gz` with mode 0600, overwriting the same day's file. The file is the same format 2 document as the nightly backup. A copy with fewer than 80 percent of the entries of the previous local copy is refused with exit 2. Exit 1 is any other failure. You can run it from cron if you want a local copy every night.

## 4. Restore

There is no restore script. A restore is the Worker's `POST /import` into an empty store, then a reindex.

1. **Import.** Send the document to `POST /import` with the admin token, in pages. The body is the document plus `offset` and `limit` (at most 200). The reply carries `next_offset` and `remaining`. Repeat with the new offset until `remaining` is 0. Links, link rejections, subjects and devices go in with the page that reaches the end of the entries. A backup from before links recorded who made them imports too, and its links are the user's. The body limit is 10 MB, so a larger store is cut into several documents, each holding some entries with their own versions, and the links, link rejections, subjects and devices in the last one.
2. **Be sure it is safe to repeat.** A memory that already exists is skipped whole, with its versions and questions, so sending a page twice changes nothing. Ids, times, validity, trash times and content come back exactly. A device is only accepted with a 64 character hash, never with a token. A bad entry is reported and skipped and the good ones still go in.
3. **Subjects.** The reply counts them as `subjects`. A subject comes back only when its card memory is in the store by then, so import the card with it. A slug that is taken is skipped. A row with a kind, status or scope the Worker does not know is reported in `errors` and skipped. A backup from before subjects has none and imports as it always did. A backup from 2.0.8 has subjects without the three brief columns, and they come back as subjects whose brief was never built, so the brief step rebuilds them once `SUBJECTS_AUTO` and `SUBJECTS_BRIEFS` are on.
4. **Devices and private subjects.** A restore still brings every device back revoked unless named in `reactivate_devices`. `allow_private` comes back as stored. A backup from before the flag has none, and such a device may see private subjects, the same as a device made today.
5. **Reindex.** `POST /admin/reindex` until `remaining` is 0. Vectors are not part of a backup. The reindex keeps the question keys that the import stored and gives them vectors, so a restored store finds a memory by its question again. A memory in the trash keeps its question rows and gets vectors when it is restored from the trash. New vectors take about two minutes to become searchable by meaning.

`migration/migrate_v1_to_v2.py load DOCUMENT.json` does both steps. It reads an uncompressed document, so gunzip the backup first. It needs `TARGET_URL` and `TARGET_TOKEN`, and `TARGET_ACCESS_CLIENT_ID` and `TARGET_ACCESS_CLIENT_SECRET` when the target is behind Access. Three things to know. It sends 50 entries per page. It sends the question keys that the document holds. A document made by the converter from the old Worker has none, so for that one run `migrate_v1_to_v2.py questions` afterwards to write them. And it refuses the host named in `ANYMEM_LIVE_HOST`, because it was written for a rehearsal, so it cannot restore into that host.

### Subjects for the people you already have

`node scripts/subjects-from-people.mjs` makes a subject of kind person for each person memory that has none, so an install with people from before subjects does not start them by hand. It needs `ANYMEM_URL` and the admin token in `ANYMEM_TOKEN`, and `ANYMEM_ACCESS_CLIENT_ID` and `ANYMEM_ACCESS_CLIENT_SECRET` when the Worker is behind Access. It is a dry run until you add `--apply`.

1. **What it reads.** Each memory with origin `person`, named `person-<slug>`. A person called Dana, saved as `person-dana`, becomes the subject `dana`. The person memory stays as it is and is not linked, because it is already the data.
2. **What it copies.** The Relationship, Known as, Work and Birthday lines, and the Contact line, or the Email and Phone lines joined when there is no Contact line. Nothing else is copied.
3. **What it leaves out and says so.** A line that looks like health, money, legal or ID text, a line marked unconfirmed, and a line over 200 characters. A name that is not `person-<slug>` with a usable slug is skipped and named.
4. **Safe to repeat.** A person whose slug already has a subject is skipped, so a second run creates nothing. One refusal from the Worker is reported and the run goes on, and the exit code is 1 if any write failed.

### What is proven

1. **On invented data, in the tests.** `worker/test/backup.test.js` ends with a restore proof. It backs up a populated store, restores it into an empty one, and compares everything field by field. It also covers paged import equal to one call, a second import changing nothing, and a reindex making recall work.
2. **On the author's real data, through the same importer.** On 2026-10-17 a converted 1,076 row document was imported into an empty rehearsal Worker twice, and `migration/compare.py` found 0 differences both times in memories, versions, links and the content of every row.
3. **Not proven.** A restore from a real nightly R2 backup. The rehearsal Worker had no nightly backup yet, so the doctor warned about it, as expected on a new store.
