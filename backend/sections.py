"""Split a reply into titled sections: markdown headings, else paragraph blocks."""
import re

from clean import strip_code

HEADING = re.compile(r"^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$")
MAX = 12


def title_of(text):
    t = re.sub(r"[`*_~#\[\]]+", "", text)
    t = re.sub(r"^\s*\d+[.)]\s*", "", t).strip()
    return (t[:22] + "…") if len(t) > 23 else t


def split(reply):
    """[(title, raw text)], at most MAX; each heading's words open its own section."""
    lines = strip_code(reply).splitlines()
    secs, title, buf = [], None, []
    for ln in lines:
        m = HEADING.match(ln)
        if m:
            if "\n".join(buf).strip():
                secs.append((title or "Intro", "\n".join(buf)))
            title, buf = title_of(m.group(1)), []
        else:
            buf.append(ln)
    if "\n".join(buf).strip():
        secs.append((title or "Intro", "\n".join(buf)))
    if len(secs) <= 1:  # no headings: one section per paragraph block
        blocks = [b for b in re.split(r"\n\s*\n", strip_code(reply)) if b.strip()]
        secs = [(f"Part {i + 1}", b) for i, b in enumerate(blocks)]
    secs = [(t, (t + ".\n" if not t.startswith(("Intro", "Part ")) else "") + body) for t, body in secs]
    if len(secs) > MAX:  # fold the tail into the last button rather than drop it
        secs = secs[: MAX - 1] + [(secs[MAX - 1][0], "\n\n".join(b for _, b in secs[MAX - 1:]))]
    return secs
