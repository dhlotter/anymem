# Moving from a version 1 store

This page is for a store that ran the old Worker, the one that came before version 2. The tools in `migration/` read that store, convert it, load it into a version 2 Worker and check that the copy matches. They only work on a store with the old Worker's read routes. A new store needs none of this.

The old store is only read, never changed. The tools were rehearsed twice, loading an export of the author's store into a separate Worker, and have not been run on any other store. Run the compare step and read its result before you rely on the copy.

## What the tools do

| Tool | Job |
|---|---|
| `migrate_v1_to_v2.py export` | Reads the old Worker with GET only and saves everything it exposes to one file (mode 0600) |
| `migrate_v1_to_v2.py convert` | Maps that file to a version 2 import document and reports anything it could not map |
| `migrate_v1_to_v2.py load` | Sends the document to a version 2 Worker in pages, then reindexes until the vectors are done |
| `migrate_v1_to_v2.py questions` | Writes the search questions for every memory, then reindexes |
| `compare.py` | Compares two stores, or a store and a document, row by row. Prints PASS or FAIL and the first differences, ids and field names only |
| `harness_backfill.py` | Fills in the harness of memories that have none, see the end of this page |
| `rehearse.py`, `reset_rehearsal.py` | A timed dry run against a Worker whose name starts with `anymem-rehearse`, and a reset for it. Optional |

The source comes from `ANYMEM_URL`, `ANYMEM_TOKEN` and, behind Access, `ANYMEM_ACCESS_CLIENT_ID` and `ANYMEM_ACCESS_CLIENT_SECRET`. The target comes from `TARGET_URL`, `TARGET_TOKEN`, `TARGET_ACCESS_CLIENT_ID` and `TARGET_ACCESS_CLIENT_SECRET`. Credentials are never printed.

**A safeguard.** `load` and `questions` refuse a target whose hostname is the one in `ANYMEM_LIVE_HOST`. Set it to the host of your version 1 Worker before you load, so a wrong `TARGET_URL` cannot write into the store you are copying from. If it is not set, the guard does nothing.

## What is carried

1. **Content.** Parsed into name, description, type and body. The stored text stays exactly as it was.
2. **Status.** The `status:` tag becomes the status column. No status, or the old draft, becomes active.
3. **Origin.** `session-capture` becomes `capture`. `claude` becomes `explicit`. `vault-memory-import` and `zcode-native-memory` become `import`. `profile`, `person` and `system` keep their names. Any other source becomes `explicit`.
4. **Harness, session, project and kind.** The `captured-by`, `session`, `project` and `kind` tags become columns.
5. **Pinned.** The capsule, profile and person memories are pinned.
6. **Validity.** `valid_from` and `valid_until` carry over. A `supersedes` edge becomes `superseded_by` on the replaced memory.
7. **Versions.** Carried in full where the old store shows them in full. See the losses.
8. **The trash.** Becomes soft deleted rows.
9. **Links.** `about_person` links carry over.
10. **Rolled up entries.** Entries tagged `rolled-up` or `synthesized` go to the trash.
11. **Dates and counts.** Created and updated times, and recall counts.

## Known losses

The old Worker's read routes do not expose some of what version 2 holds. The tools say so rather than guess.

| What | What happens |
|---|---|
| The trash | Each item arrives as a 160 character preview. It becomes a soft deleted row that holds the preview, tagged `migrated-preview-only` |
| Version history | Only changes that left the content alone (status changes) are rebuilt as full versions. An update, append, tag or validity change, and every older change, is counted and not stored, because the old Worker only shows a 160 character preview of the earlier text. `convert` reports the count |
| Device tokens | Devices are listed without a token hash, so none can be copied. Create each one again on the new Worker with `devices.py add` and update that machine |
| The inferred graph | Every edge except `about_person` is dropped on purpose. Version 2 has no inferred graph |
| Importance and contradiction counters | Dropped. Version 2 has no such columns |
| Search questions | Not in the old store. `questions` writes them afterwards, which takes a while on a large store but needs no downtime |

## The steps, in order

Each step ends with something that must be true before the next.

1. **Set up an empty version 2 store** with `setup.py`, as a Worker of its own with its own database, vector index and backup bucket. See [install](install.md). Do not reuse the version 1 Worker or its resources.
2. **Stop writes to the old store.** Set `ANYMEM_CAPTURE=0` in every harness that has the hooks and avoid saving by hand. Check the old Worker's `GET /count` twice, a minute apart. It must not move.
3. **Export.** `migrate_v1_to_v2.py export --out export.json`. A full export makes one history call per entry, so it is slow on a large store. With `--since` an earlier export, only changed or new entries are read again. Take a full export ahead of time and a `--since` export once writes are stopped.
4. **Convert.** `migrate_v1_to_v2.py convert export.json --out document.json`. It exits 1 and lists the ids in `errors` when an entry cannot be stored. Any id in that list means stop and look.
5. **Load.** `migrate_v1_to_v2.py load document.json` sends pages of 50 entries (change it with `--page`) and then reindexes. Loading the same document again imports nothing new, because a memory that already exists is skipped. It exits 1 if any entry was refused.
6. **Compare.** `compare.py document.json target`, and `compare.py document.json target --v1 export.json` to check the target against the raw export with no mapping code. Each must print PASS with 0 differences. A FAIL means stop. The old store is untouched.
7. **Questions.** `migrate_v1_to_v2.py questions` writes the search questions and reindexes. A memory whose model call failed stays unmarked, so run it again later.
8. **Check recall.** `doctor.py --probe`, then `bench/bench.py` and `bench/recall_gate.py --server --real` against the new Worker with your own sets. See [benchmark](benchmark.md). Rerun them on your own store, because the numbers in the benchmark page come from one store and one Worker.
9. **Switch your clients.** Make a device for each machine with `devices.py add NAME --share`, connect it with `connect.py`, restart open sessions and unfreeze writes. Watch `doctor.py` and `usage.py` for a week. The first nightly backup runs at 01:00 UTC.

Keep the old Worker and its data until you have used the new store for a while. Anything written to the new store after the switch is not in the old one.

## Harness backfill

A memory with no harness shows as Imported or Unknown on the dashboard. `migration/harness_backfill.py` lists the open memories with no harness and fills in the ones whose tags name exactly one known harness (a `captured-by` or `harness` tag, or a `session` tag that starts with a harness name). It is a dry run unless you pass `--apply`. It reads with `GET /list?harness=none` and writes with `POST /admin/harness`, which is admin only, never replaces a harness and leaves `updated_at` and the history alone. A memory whose tags point at two harnesses, or at none, is left blank. Set `TARGET_URL` and `TARGET_TOKEN` (and the Access values when the Worker sits behind Access), run it once without `--apply` and read the report. It has only been run against fakes in the tests.
