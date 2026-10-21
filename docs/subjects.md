# Subjects, and letting anymem do part of the work

A subject is a thing your memories are about, such as Pip the dog, the Corolla, a project or Dana the colleague. You can make and change subjects by hand, see [commands](commands.md) and [dashboard](dashboard.md). This page is about the part anymem can do by itself. It can link a new memory to the subject it is about, suggest a subject for something new, and keep each subject's short brief up to date. All of it is off until you turn it on, and you stay in charge of what becomes a subject.

## The switch

1. **Two settings.** `SUBJECTS` makes recall offer a subject's card. `SUBJECTS_AUTO` lets the Worker act on subjects by itself. Both are Worker variables, `on` or `off`, and both default to off.
2. **Both must be on.** Nothing automatic runs unless `SUBJECTS` and `SUBJECTS_AUTO` are both `on`. That covers linking after a write, proposals from a hint, the nightly clustering step and the nightly brief step. With either one off, the Worker does what it did before this existed.
3. **How to turn it on.** Add `"SUBJECTS": "on"` and `"SUBJECTS_AUTO": "on"` to the `vars` block of `worker/wrangler.jsonc`, then run `setup.py` again. Setup copies that block on every run. To turn it off, set `SUBJECTS_AUTO` to `off` or remove it, and run setup again.
4. **What works whatever the switch says.** Your own clicks (Accept and Dismiss), the two preview routes and the replay script. They either are your decision or write nothing.
5. **Check it.** `anymem doctor` prints a `subjects` line such as `3 active, 1 proposed, 0 stale, 0 private, auto on`. It says `auto off` when `SUBJECTS_AUTO` is not on, and `auto set but SUBJECTS is off, so it does nothing` when only the automation switch is set. The line needs the admin token, because the switches come from `GET /stats`. With a device token, or an older Worker that does not report them, you get the counts and nothing more.

## See what it would do first

Before you switch `SUBJECTS_AUTO` on, look at what linking would do to your own memories. Run the replay script as the admin.

```
ANYMEM_URL=https://memory.example.com ANYMEM_TOKEN=... node scripts/subjects-replay.mjs --days 7 --sample links.tsv
```

It walks `GET /admin/subjects/assign-preview` a few memories at a time and writes nothing to the store. It prints how many memories it saw, how many would link, how many links that is, and how many have an ambiguous name. It also writes up to 40 random would-be links to the file you name, one a line, with tabs between the memory name, a snippet, the subject slug, the confidence and how it was decided. Read the file. If more than 1 in 20 of the links is wrong, leave `SUBJECTS_AUTO` off. The file holds memory text, so keep it out of any repository.

The script reads `ANYMEM_URL` and `ANYMEM_TOKEN` from the environment, and `ANYMEM_ACCESS_CLIENT_ID` and `ANYMEM_ACCESS_CLIENT_SECRET` when the Worker sits behind Access. It never follows a redirect, so the token cannot be sent to an address you did not set.

For the proposals the nightly step would make, call `GET /admin/subjects/cluster-preview` with the admin token. It lists the groups it would propose, with the notes behind each, and the groups it dropped and why.

## Linking a memory to its subjects

After a memory is saved and the reply has gone, the Worker looks at which subjects it is about. This happens in the background, so saving is no slower.

1. **By name.** The subject's slug, its name and its aliases are looked for in the memory as whole words. Pip matches "Pip's bowl" but not "Pipeline". A name of fewer than 3 characters never matches. A match is certain, confidence 1.0.
2. **By neighbours.** If at least 3 of the 5 closest memories already belong to the same subject, and the closest of them is at least 0.6 similar, the memory is linked with a lower confidence. A link below 0.5 is never made.
3. **A name two subjects share links to neither.** If Rowan is the name of a dog and of a colleague, a memory that says only "Rowan" is left alone, and the audit shows an `assign.ambiguous` row. A name that only one of them has settles it.
4. **Never again.** A link you refuse is never made again. See below.
5. **Not everything is linked.** A profile, person or system memory is never linked, and one write links a memory to at most 3 subjects.
6. **Private subjects.** The Worker may link to a private subject. A device whose private access is off is never linked to one by this step, so a private subject cannot be inferred from the writer's own memories.

Every link the system makes is written to the audit trail with the system as the caller, and with how it was decided, for example `how:alias.conf:1.0`.

## Subjects waiting for you

When automation is on, anymem can propose a subject by itself, for example when you say "Pip is my dog" or when five memories keep using the same tag. A proposal is not a subject yet. Recall never offers it and no memory is moved into it. It waits for your click.

You see proposals in two places. The Home page lists them under Subjects waiting for you. The Subjects item in the sidebar shows how many there are.

1. **Accept** makes the subject active. From then on recall can offer its card, and new memories can be linked to it. The memories that caused the proposal stay linked as its first members.
2. **Dismiss** retires the proposal and keeps its name taken, so the same proposal does not come back. There is no undo for a dismissal. If you change your mind, bring the subject back to active from the Subjects screen, which also makes its card active, or make a subject by hand with a different slug.
3. **Open** shows the subject in its drawer. The memories listed there are the evidence for the proposal.

You can also run `subject.py list --status proposed` to see them, and `subject.py accept SLUG` or `subject.py dismiss SLUG` in your own terminal. An agent never runs those two.

A memory the system linked to a subject shows "made by the system, confidence 0.80" in the memory drawer and in the list of members of the subject. Press Not this to refuse that link. anymem remembers the refusal and does not make the same link again.

## What makes a proposal

1. **A hint from the extractor.** When capture reads a session, the extractor may add a subject hint to a memory that introduces a named person, pet, vehicle, property, project or topic with its own identity. "Pip is my dog" gives the name Pip and the kind pet. It never sets a hint for a general rule, a preference, a company or a tool, unless the tool is your own project. The Worker checks the hint again. The name must be 2 to 60 characters, must not be a generic word such as "team" or "project", must hold no secret or instruction, and must appear in the memory's own text. A hint is used only when the linking step did not link the memory to any subject. At most 25 proposals wait at once, after that a hint is dropped.
2. **Nightly clustering.** Once a night the Worker looks for recent captured and explicit memories that belong to no subject and share a name. It groups them by a shared tag, a shared project or a shared first word of the memory name. A group of five or more is a candidate. It then reads the stored vectors of the group and drops it unless the memories are close in meaning (mean cosine of at least 0.55). A group it cannot check inside the night's budget is dropped, never proposed unchecked. It makes at most three proposals a night.
3. **Only new names.** A name that already exists as a subject in any status, or as an alias of one, is never proposed. That includes a dismissed proposal.
4. **Safe to ignore.** A proposal that sits there does nothing. Each proposal is written to the audit trail, and nothing is deleted when you dismiss one.

## The brief

A subject card holds a short brief. You can write it yourself, or let anymem build it.

When anymem builds it, it reads the newest 20 memories about the subject and asks the small model to write a few short lines, under Now and History. Each line says which memories it comes from. Before anything is saved, anymem checks every line.

1. **A line must cite a memory of the subject.** A line that cites nothing, or a memory that is not a member, fails.
2. **A cited memory must still count.** A memory that has been trashed or replaced since the model saw it fails.
3. **Every number and date must be written in a memory the line cites.** A month is kept apart from plain numbers, so "12 kilos" never supports "December".
4. **At most 12 lines and 900 characters, and no line that reads as an order.**

If one line fails, the whole brief is thrown away. The old brief stays, the subject shows as stale, and the reason is kept. So if Pip's brief says the vet visit is on 3 November, one of Pip's memories says so. If the model invents a weight for Pip, the brief is refused. A model that does not answer changes nothing.

1. **Each build can be undone.** A built brief is a new version of the card, so you can undo it from the card's history.
2. **Sources are linked.** The card gets a `derived_from` link to each memory its lines cite.
3. **Pin a brief you wrote.** Set the field `brief_pinned` on the subject. A pinned brief is never rebuilt and the subject is never retired automatically.
4. **The step.** It runs every night and builds at most 8 briefs. It rebuilds a subject when one of its newest 20 members was changed, added or removed. A stale subject is tried again, after the healthy ones.
5. **Retiring.** A project, an area or a topic with fewer than 3 live memories that is more than 60 days old is retired. A person, a pet or an asset is never retired this way, because they have few memories by nature. Its links stay, and you can make it active again.
6. **Private subjects.** A private subject's brief is built from its own memories only. A memory that belongs to a private subject is never shown to the model when it builds a shared subject's brief.

## What the nightly job does with this

The two steps are `cluster` and `briefs`. They run before `merge`, in the order cluster, briefs, merge, because merge keeps going until the shared subrequest budget is gone. The Health screen shows what each did. A step that reports `skipped: "off"` is working as designed. A step that reports dropped `low_cohesion` often means the tag is too broad to be one subject.

## What is not built

Anymem does not yet propose a value for a subject's field, such as a vet or a birthday. It does not record decisions or state changes of a subject, and it does not look for contradictions between the memories of one subject. Those need a source of field values that does not exist yet. Linking, proposals and briefs are the whole of what runs on its own.
