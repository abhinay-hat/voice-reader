"""Shared text cleaning for spoken replies: markdown, tables, links and paths out, plain sentences in."""
import re

SEP = re.compile(r"\|?[\s:|-]+\|?")


def strip_code(text):
    return re.sub(r"```.*?```", " [code omitted] ", text, flags=re.S)


def clean(reply, limit=6000):
    out, lines = [], strip_code(reply).splitlines()
    for i, ln in enumerate(lines):
        st = ln.strip()
        if SEP.fullmatch(st) and "-" in st:
            continue  # table separator row
        if st.startswith("|"):
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if SEP.fullmatch(nxt) and "-" in nxt:
                continue  # table header row
            cells = [c.strip() for c in st.strip("|").split("|") if c.strip()]
            if cells:
                out.append(cells[0] + ": " + ", ".join(cells[1:]) + "." if len(cells) > 1 else cells[0] + ".")
            continue
        out.append(ln)
    t = "\n".join(out)
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"https?://\S+", "a link", t)
    t = re.sub(r"`([^`]*/[^`]*)`", "the file", t)            # code-quoted paths
    t = re.sub(r"(?<![\w.])~?/[\w.@-]+(?:/[\w.@-]+)+", "the file", t)  # bare paths
    t = re.sub(r"^#{1,6}\s*|^\s*[-*+>]\s+|^\s*\d+\.\s+", "", t, flags=re.M)
    t = re.sub(r"[─-╿←-⇿■-◿]", " ", t)  # box drawing, arrows, shapes
    t = re.sub(r"[☀-➿\U0001F300-\U0001FAFF️]", "", t)
    t = re.sub(r"[`*_~#]+", "", t)
    t = re.sub(r"\s*[—–]\s*", ", ", t)
    t = re.sub(r"\s+([.,:])", r"\1", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"([^.!?:])\n", r"\1.\n", t.strip())
    t = re.sub(r"\.{2,}", ".", t)
    t = re.sub(r"\n+", " ", t)
    t = re.sub(r"([.:])(\s*\.)+", r"\1", t)
    return t.strip()[:limit]
