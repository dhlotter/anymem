---
description: Connect this machine to an existing Anymem Worker
argument-hint: "(copy the connection string first)"
---

This machine joins a memory that already exists. The person has a connection string (it starts with `hm1.`), made on the machine that owns the memory by `devices.py add NAME --share`. That command writes the string to a file and prints only the file's path. It is a secret.

Connecting reads the string or the token without echo, and this shell has no terminal to type into. So the person runs these commands in their own terminal (in Claude Code, type them with a `!` prefix). Never ask for the string or the token in chat, never print it, never write it into a file, and never put it on a command line. `connect.py` refuses a connection string given as an argument, and it has no flag that takes the token or the Access secret.

If $ARGUMENTS starts with `hm1.`, the string has already been typed into this chat. Do not repeat it or run it. Ask the person to copy it to the clipboard and use step 2.

1. Ask them to copy the string to the clipboard.
2. Give them the line for their system. On macOS: `! pbpaste | python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/connect.py`. On Linux: `! xclip -selection clipboard -o | python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/connect.py` (or `wl-paste`). If $ARGUMENTS holds a Worker address instead, give them `! python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/connect.py $ARGUMENTS`, which asks for the token without echo in their terminal.
3. If the clipboard does not hold a connection string, tell them to run `! python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/devices.py add NAME --share` on the machine that owns the memory. It prints the path of a file only they can read. They copy that file to the clipboard (`pbcopy < FILE` on macOS, `xclip -selection clipboard < FILE` on Linux), delete the file once this machine has connected, and say when they have.
4. When it connects, run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/anymem/scripts/doctor.py --probe` and report the result.
