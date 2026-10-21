# Dashboard

The Worker serves a dashboard at its own address. It is plain HTML, CSS and JavaScript modules in `worker/ui/`, with no build step and nothing loaded from another site. Open the address of your Worker in a browser and log in through Cloudflare Access with the email you gave setup.

It needs Access. A browser login on the `ACCESS_ALLOWED_EMAILS` list is the only thing that can load the pages. A bearer token or a service token gets 403 `browser_only`. The browser never holds a token. You do not type one, and the page never reads or stores one. Without Access there is no dashboard.

## What it shows

A sidebar on the left holds the brand, a search and jump box (press Ctrl K or Cmd K anywhere), the screens with live counts, and at the foot the version, whether the search index is in sync, the host and a theme switch. On a phone the sidebar becomes a drawer. The theme follows your system, and you can pin light or dark. The page is built so that when all is well it is quiet, and a problem rises to the top.

The address bar uses hash routes, so each screen has a link you can bookmark. Filters, the sort and the open memory are part of the address. A memory opens in a drawer on the page you are on, for example `#/trash/<id>` or `#/capsule/<id>`, so reading never takes you off the list. Escape or the close button brings you back, and the drawer is the same on every screen.

| Screen | Route | What it does |
|---|---|---|
| Home | `#/home` | A greeting. One status line that says all is well, or lists what needs attention (the nightly job, the backup, the search index against the database, the Access token, writes held back by the limit, refused captures, failed model calls, changes waiting for you). The week in numbers. Memories saved over time, stacked by origin, for 30 days, 90 days or a year, with a table view. Recall calls per day, with the hook quiet rate over 7 and 30 days and a table by tool. The most recalled memories and the ones never recalled. The live count, the memories added this week and the never recalled list leave out subject cards, because a card is not a memory you wrote. Where memories come from, by harness. Which memories each tool was given most. Captures on probation with the days left. When anymem has proposed subjects, a list called Subjects waiting for you, with Accept, Dismiss and Open on each line |
| Search | `#/search?q=` | A prompt and a Search button, and Enter searches. It cleans the prompt the way the recall hook does, runs `GET /recall` with `topK=3` (the hook's), `explain=1`, `checks=1` and `count=0`, and shows the exact text the hook would add. That text leaves out a project memory unless the search names its project, as the hook does outside it. Every hit is a table row with its tool, closeness, reranker score, rank score and which of the two searches found it, and Why opens the rare words it matched and every relevance rule with whether it held. A `project` in the address scopes the search like a session inside that project. It does not count as a recall |
| Memories | `#/memories` | A compact table, one line a memory, with the filter and the sort in the column headers. A funnel in a header opens that column's choices (status, origin, tool, type, project, a tag, a saved time range), the filters in use are listed above the table with a way to take each off, and Recalled, Changed and Saved sort, newest first. A row opens the memory in a drawer with its text, facts (tool, session, who saved it, which tools were given it), links and history. Each history entry shows a line diff of what changed. Edit, append, change status, link, undo, and move to the trash (with an undo). The drawer's Links section is described below |
| Activity | `#/activity` | What the system did on its own, newest first, as a table. Memories replaced by a newer fact, merged by the nightly job, and retired by the probation rules. The What and Now headers filter by kind and by where the memory stands. Each row has an Undo while undo still works, and a row opens the memory in a drawer |
| Trash | `#/trash` | Memories forgotten in the last 14 days, as a table, the closest to the end first or the newest forgotten first. Origin and project filter it, a row opens the memory in a drawer, and Restore is on each row |
| Capsule | `#/capsule` | The text that opens every session. A size figure with a word for how full it is, a ruler of the 9,500 character cap (also where the session start hook cuts the text), a table of the sections with each one's share and the standard slots that nothing fills, and the text as the hook joins it, with Copy. A section opens its memory in a drawer, where it can be edited |
| Profile | `#/people` | Changes waiting for you, one line each with the value now and the value proposed, then the profile as a table. A proposed subject is not counted here, it waits on Home. A row opens its memory in a drawer. The people you talk about are subjects of kind person, on the Subjects screen |
| Subjects | `#/subjects` | The things your memories are about, such as a pet, a car or a project, as a table. The Subject header filters by name or alias, Kind, Status and Scope have a funnel, and Subject, Members and Changed sort. A row opens the subject in a drawer, and New subject makes one. The sidebar item shows how many proposed subjects wait for you. Described below |
| Health | `#/health` | The checks. The nightly job as a grid of steps over the last runs. Database and vector size against the plan. The write limit by token. Captures proposed, screened out, saved and refused for 14 days. A step of the nightly job that was refused shows its own reason when it gives one, for example the brief step says the model did not answer, and the backup step keeps its wording about fewer entries than the last backup. Backups with a download. Counts by status, origin, kind and project |
| Audit | `#/audit` | The Worker's audit trail as a table, with the filter in the column headers for caller (the ones seen lately, named by the Worker), route, result and time, and calls per day. No memory text is shown |

The old addresses `#/browse` and `#/memory/ID` still work and land on Memories.

## What it measures, and what it cannot

1. **Recall.** The audit table records which route was called and which memory ids came back, but not the query. So the dashboard counts recall calls from machines, and how many of them returned nothing at all. What the hook then did with the answer is decided on your machine, so the hook reports it itself. Each hook notes whether it added memories to a prompt (injected), found nothing good enough (quiet), or could not search (failed), and sends the totals with its next request. Home shows the quiet share over 7 and 30 days from those reports. A client that has not been updated reports nothing, so its tool shows no quiet rate, and Home says since which day any hook has reported. A search that could not run is left out of the rate. The last decision before a machine goes silent waits for its next request, so the newest prompts can be missing.
2. **Plan limits.** The database limit (10 GB) and the vector limits (20,000,000 vectors in an index, 10,000,000 stored dimensions included in the plan) are written in `worker/plan-limits.js` from the Cloudflare documentation of 2026-10-18. They are not read from your account, so a plan change needs an edit there. The database size comes from the size D1 reports with a query, and the page says when a Worker does not report it.
3. **Where a memory came from.** Each memory keeps the harness that saved it, taken from the name the client sends. A memory saved before clients sent a name has none. It is shown as Imported when it was imported and Unknown otherwise, and the Memories filter can list them. A script run by an agent inside another harness learns its harness from a note the harness's hooks leave in the cache folder (up to 4 hours old), so a save from a script is a best guess when two harnesses run at once. `migration/harness_backfill.py` fills in the blanks that carry evidence in their tags.
4. **Which tool was given which memory.** Each counted recall stores one short row per relevant memory (time, harness, memory id, no query text) for 90 days. Most used by tool and Recalled by in the memory panel read it, and both say since when it has been recording. A memory saved before recording started shows no use even if it was recalled. The use log is derived data and is not part of an export or a backup.
5. **Who saved a memory.** Saved by in the memory panel is found in the audit trail by the time of the save, so it exists for 90 days and for a save made through `/capture`. An import, an older memory and a memory saved by a call the audit trail no longer holds say so. A device token is never told which other device saved a memory.
6. **Remember something.** A browser login may only save profile and person notes. So Remember on Home and in the command palette does not save anything. It builds the `remember.py` command for you to copy and run where the skill is installed, or to hand to an agent.

## Links in the memory drawer

The Links section lists every live link of the open memory, read from `GET /links`, grouped by type in the order of the closed type list (`about`, `part_of`, `owns`, `affects`, `decided`, `supersedes`, `contradicts`, `derived_from`, `about_person`, `related`). Each row names the other memory and opens it in the drawer, and says whether the link goes to it or comes from it. A link of an older type outside the list is shown under `related`.

1. **Made by you or an agent.** A link saved by a person or an agent has a Remove button. It calls `POST /unlink`, and the toast has an Undo that adds the link again. A link of an older free text type has no Undo, because that type can no longer be added.
2. **Made by the system.** A link the system made reads "made by the system, confidence 0.80". Its button is Not this. It calls `POST /unlink`, which also records the refusal, so the system never makes that link again. That cannot be undone from the drawer.
3. **Add a link.** The Link button opens a small form with the other memory's id and a type chosen from a list. The list leaves out `supersedes` and `derived_from`, which only the system writes.

## Subjects

A subject is a thing memories are about. Its card is an ordinary memory that holds the brief, and a row in the subjects table holds its kind, status, scope, fields and aliases. The Subjects screen reads `GET /subjects` with the kind, status, scope and name filters of the headers, sorts the answer on the page, and shows one row a subject. The address keeps the filters and the open subject, for example `#/subjects?kind=pet&subject=pip`.

1. **The subject drawer.** A row opens `GET /subject` in the same kind of drawer as a memory. It shows the name and slug, the kind, status and scope, the brief as plain text (never rendered as markup), when the brief was built, whether anymem or you wrote it, and the reason in plain words when it is out of date, the fields each with when it was confirmed, the aliases, the members as a table, and the card memory's links in the Links section described above, without buttons. A row of the members table opens that memory in the memory drawer on top of the subject. Escape closes the memory first, and the next Escape closes the subject.
2. **Scope.** A Shared and Private toggle sends `POST /subject/update` with the new scope. Only the admin token and a browser login may change it, and a refusal puts the toggle back and says why. A private subject is hidden from a device whose `allow_private` flag is off, together with its card and the memories that are only about private subjects.
3. **Edit brief, Edit fields, Add alias.** Each opens a small form in the drawer and posts `POST /subject/update`. The fields form lists the keys of the subject's kind, sends only the boxes that changed, and removes a field when its box is emptied. A field edited here is marked confirmed now. Saving a brief pins it, so anymem does not rewrite it. The fields form does not list the pin. Set it or remove it with `POST /subject/update`. Adding an alias sends the whole list in lowercase, and each alias has a Remove button.
4. **Retire.** Retire sets the status to `retired`, and the toast has an Undo that sets it back to `active`. A retired subject shows Bring back instead, which also makes its card memory active when the card was still pending, as it is for a dismissed proposal. The statuses `proposed` and `stale` are never set from the dashboard. A proposal is decided with Accept or Dismiss, described below.
5. **New subject.** The button opens a form with kind, name, slug and brief and posts `POST /subject`. The slug is 2 to 40 lowercase letters and numbers with single dashes, checked in the page and again by the Worker, which refuses a slug that is taken. A new subject opens in its drawer.
6. **Subjects in the memory drawer.** A memory shows a Subjects row of chips when it has an `about` link to a card. Each chip opens the subject. The page reads `GET /subjects` to know which links end at a card, and leaves the row out when the Worker has no such route.

Adding a memory to a subject is a link of type `about` from the memory to the card, made with the Link button in the memory drawer. With `SUBJECTS_AUTO` on, the Worker also links new memories by itself and proposes subjects, see [subjects](subjects.md).

### Subjects waiting for you

When automation is on, anymem can propose a subject by itself, for example when you say "Pip is my dog" or when five memories keep using the same tag. A proposal is not a subject yet. Recall never offers it and no memory is moved into it. It waits for your click.

1. **Where you see it.** Home lists proposals under Subjects waiting for you. Each line has the name, the kind and how many memories back it. The Subjects item in the sidebar shows how many there are.
2. **Accept** calls `POST /subject/accept`. The subject becomes active, so recall can offer its card and new memories can be linked to it.
3. **Dismiss** calls `POST /subject/dismiss`. The proposal is retired and its name stays taken, so the same proposal does not come back. There is no undo for a dismissal. If you change your mind, use Bring back on the retired subject, or create the subject by hand with a different slug.
4. **Open** shows the subject in its drawer. The drawer says "Proposed, waiting for your click", has the same Accept and Dismiss buttons, and lists the evidence memories as members.
5. **Members the system linked.** A member the system linked shows "made by the system, confidence 0.80" and a Not this button. It refuses the link for good, and the system never makes it again.

## What it can write

A browser login may change memories only through the routes the screens use, `/capture`, `/update`, `/append`, `/status`, `/forget`, `/restore`, `/undo`, `/link`, `/unlink`, `/subject`, `/subject/update`, `/subject/accept` and `/subject/dismiss`. Through `/capture` it may only save profile and person notes, which is what the Profile screen needs. It cannot create device tokens, import, reindex, run the nightly job or run a backup. Each write must come from the dashboard's own page. See [security](security.md) for the checks.

The insight routes only read. A test checks that calling each of them changes no table except the audit trail.

Every API call and write a browser makes is in the audit table, with the actor `browser`, the email and the harness label `dashboard`. A successful load of the dashboard files themselves is not recorded.

The browser stores one small choice, the theme, under the key `anymem-theme`. Nothing else is stored in the browser, and a test checks that no other file touches storage.

## How it is built

1. The Worker handles every request first, so authentication gates every file and no file is public. The files are served from the Workers static assets binding.
2. The Content Security Policy is `default-src 'none'`, with scripts, styles, images and connections allowed only from the page's own origin. The page loads nothing from another site. That also rules out web fonts, so the dashboard names platform fonts and falls back to the system.
3. Every value that comes from the store is escaped before it becomes markup. A memory with hostile text, such as script tags, shows as text. The tests render every view with hostile text and check that it adds no tag and no attribute.
4. Colours and fonts come only from tokens at the top of `style.css`, light and dark. A test fails if a colour or a font appears anywhere else.
5. Charts are hand written SVG with no library. Each has a legend, a table view and a tooltip that also works from the keyboard with the arrow keys. Status is always a word and a shape as well as a colour.
6. One module per screen, one `fetch` helper, and pure helper modules with their own unit tests.

## Status of testing

1. The Worker's tests cover the routes, the browser login rules, the cross site write checks, the files being served, the new read routes, and the rendering of every screen against fakes.
2. The screens were looked at in a browser against the real Worker code over in memory fakes with invented data, in light and dark, at phone and desktop widths. The hallmark slop gates that can be measured and the axe accessibility scan were run on every screen.
3. What the author has not checked is a real browser login on a real hostname. That means Access passing its cookie and `Origin` unchanged, the shape of a real browser token, and the write clicks against the live store. The first real login will settle it.

## Looking at it without Cloudflare

For development only, `node worker/dev/dev-server.js` runs the real Worker code over in-memory fakes at http://127.0.0.1:8787, signs a browser login for you on every request, and seeds a few memories, some with hostile text. It is never deployed and needs Node.js, which nothing else in Anymem needs.
