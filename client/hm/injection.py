"""A local record of what the hooks put into a prompt, so `usage.py` can say what memory costs.

One JSON line per event in the cache folder's injection.log: when, what kind (start or recall), how many characters were added, and
for recall how many memories, their similarity scores and how many more were relevant but cut by the limit. No prompt text and no memory
text is written, only counts and the 12 character session tag (hm/audit.py session_tag). The file is trimmed to its newest lines. Nothing here can raise.

fence() makes stored text safe to put into a prompt: the hooks wrap each memory in <memory> tags and call it on the text first."""
from __future__ import annotations

import json
import re
import time

from hm import cache_file, config

MAX_BYTES = 600_000
KEEP_LINES = 3000


def fence(text) -> str:
    """Stored text, made safe to inject. A '<' that starts a tag becomes &lt;, so a memory cannot open or close one of the
    <memory> blocks around it. A '#' that starts a line is escaped, so a memory cannot start a heading in the context."""
    return re.sub(r"(?m)^(\s*)#", r"\1\\#", re.sub(r"<(?=/?[A-Za-z!])", "&lt;", str(text)))


def path():
    return config.cache_dir() / "injection.log"


def record(**fields) -> None:
    try:
        p = path()
        cache_file.private_dir(p.parent)
        with cache_file.open_append(p) as f:
            f.write(json.dumps({"ts": round(time.time()), **fields}, separators=(",", ":")) + "\n")
        if p.stat().st_size > MAX_BYTES:
            lines = p.read_text(encoding="utf-8").splitlines()[-KEEP_LINES:]
            cache_file.write_text(p, "\n".join(lines) + "\n")
    except Exception:
        pass


def read(since: float = 0.0) -> list:
    out = []
    try:
        for line in path().read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict) and float(d.get("ts") or 0) >= since:
                out.append(d)
    except OSError:
        pass
    return out
