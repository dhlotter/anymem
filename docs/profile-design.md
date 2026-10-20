# Profile and people

Facts about you ("what is my street address", "what is my phone number") and about the people you talk about are kept as small memories of their own, not buried in notes. This page says how they work. The scripts are `profile.py` and `person.py`, see [commands](commands.md).

Why it exists. On 2026-10-10 a question about a contact detail found a loosely related note instead, because the detail itself was not in memory at all. For someone with no notes vault the memory store is the only source of truth, and nobody wants to maintain a profile by hand.

## The profile

One memory named `profile`, with origin `profile`, status `canonical` and the `pinned` flag, so no automatic rule ever changes it. It is tagged `profile` plus the words people ask with, such as address, phone, name and email, so a question using those words finds it first. Its body is labelled lines.

```
Full name: Sam Example (confirmed 2026-10-10)
Home address: 1 Example Street (confirmed 2026-10-10)
```

Fields are `name`, `preferred-name`, `last-name`, `email`, `phone`, `address`, `postal-address`, `work`, `work-address`, `language`, `timezone` and `units`. Each line carries the day it was confirmed, or says it was worked out from something and is unconfirmed.

1. **Updating does not duplicate.** `profile.py set address "..."` edits the matching line through the Worker's versioned update. There is never a second address, and the old value stays in the memory's history (`history.py`, `undo.py`).
2. **A worked out value is flagged.** `--derived-from WHAT` saves a value marked as derived and unconfirmed until you run `profile.py confirm FIELD`. A derived line is shown as unconfirmed whenever it is used.
3. **Blocked topics are refused.** A value about health, money details, legal matters or a government ID number is refused with exit 2. An address or phone number you state is allowed.

### What writes to it

1. **You, directly.** "My new number is..." in a session makes the agent run `profile.py set`. The skill says to do so only when you state it about yourself in this conversation, never for something read from an email or a page.
2. **Capture, for a fact not yet there.** At session end the extraction also returns facts you stated about yourself. A fact counts only when the quoted words are in one of your own turns and contain the value. The Worker's extractor adds more checks. The quote must be first person, must not start with an approval or a greeting, must not sit in a turn that reads like an email, and a language, timezone or units fact needs a quote of at least 20 characters. A fact not in the profile yet is added.
3. **Capture, for a different value.** A different value for a fact that already has one becomes a pending change. It is a memory named `profile-proposal-FIELD`, tagged `profile-proposal`, with status `pending`, which recall never injects. The session start line tells you, `profile.py pending` lists it, `profile.py accept FIELD` applies it and `profile.py dismiss FIELD` drops it. The dashboard's People screen does the same. Nothing existing changes without you.

### What is injected, and when

Contact details are on demand only. The recall hook checks a first person question against a short list of patterns, such as "my address", "my phone", "who do I work for" and "what is my name", and reads just the matching lines straight from the profile memory. Only the asked lines are added, so a phone number or address is never in a prompt that did not ask. The always on capsule is separate, see [architecture](architecture.md).

## People

One small memory per person, named `person-SLUG`, with origin `person`, status `canonical` and the `pinned` flag, tagged `person`, `person:SLUG` and the person's name words. Its first save also makes an `about_person` link from the person's memory to your profile.

Fields are `relationship`, `name`, `last-name`, `known-as`, `email`, `phone`, `work`, `birthday`, `language`, `contact-preference` and `note`.

1. **A person needs a relationship first.** Nobody is created until you say who they are to you.
2. **Built from speech.** A second statement edits the same memory in place with history. It never makes a second memory for the same person. A name that fits two people is refused with both names listed, so it asks you which.
3. **Derived facts are narrow, flagged and unconfirmed.** An email of the form `first.last` or `first_last` whose first part is a first name already known gives the last name. An email at a company domain, not free mail, gives a work hint when there is no work line. Nothing is worked out from a phone number, an address or a tone. `person.py confirm NAME FIELD` clears the flag.
4. **Birthdays.** "Today" or "tomorrow" is resolved in code to the day and month it was on when said, and the year is kept only if you gave it. A chat as short as 30 characters is still read for a birthday.
5. **Someone you only message.** If all you say about a person is a request to send them something, they are saved as a `contact`, flagged unconfirmed, so a birthday mentioned in passing is not lost.
6. **Never recorded for anyone.** Health, money, legal matters and ID numbers, and a verdict on someone's character or mood. A diagnosis, a debt or a dispute is not stored even when you say it out loud.
7. **Only when named.** When a prompt names a saved person the recall hook adds who they are and their lasting facts. Their email, phone and contact preference are added only when the prompt asks about reaching them. Nothing about people is injected when nobody is named.
8. **Forgetting.** `person.py forget NAME` removes the memory and its link.

## What is not built

1. Merging two memories that turned out to be one person.
2. A first run interview that fills the profile.
3. A nudge for a line that has not been confirmed for a year.
4. A check of the profile in the monthly recall check.
5. Splitting the capsule's identity and preference slots from the profile.
