---
description: The user names a memory by id and confirms it is wrong. The assistant should run recall first, then forget that id. The recall result sits in the prompt so the case still runs offline.
tags: [anymem, forget]
allowed_tools: [Skill]
---
Forget the memory about staging deploys happening on Tuesdays. It's the one with id 3f9c2a7e. I checked it and it's wrong, so go ahead and forget it.

Run recall for it first, the way the skill says. That recall came back earlier as: "3f9c2a7e: Staging deploys happen on Tuesdays." If recall can't reach the store, use that result and carry on to forget.
