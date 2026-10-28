"""
Assemble the site's pages from app/src/*.html templates + app/model.json + app/sample_batch.csv.

    python model/train_export.py   # retrain + export model.json
    python app/src/build.py        # rebuild app/index.html, login.html, app.html, 404.html

Placeholders in a template:
    <!--#head-->     shared <head> tags (app/src/head.html)
    <!--#model-->    model.json as a <script type="application/json" id="model-data"> block
    <!--#sample-->   sample_batch.csv as a JSON string in <script type="application/json" id="sample-data">
JSON data blocks are not executed, so the Content-Security-Policy needs no 'unsafe-inline' for scripts.
"""
import json
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
SRC = APP / "src"
OUT_NAME = {"landing.html": "index.html"}  # every other template keeps its name

model = json.loads((APP / "model.json").read_text())
sample = (APP / "sample_batch.csv").read_text()
head = (SRC / "head.html").read_text().strip()


def data_block(block_id, value):
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/json" id="{block_id}">{payload}</script>'


parts = {
    "<!--#head-->": head,
    "<!--#model-->": data_block("model-data", model),
    "<!--#sample-->": data_block("sample-data", sample),
}

for tpl in sorted(SRC.glob("*.html")):
    if tpl.name == "head.html":
        continue
    page = tpl.read_text()
    for key, value in parts.items():
        page = page.replace(key, value)
    if "<!--#" in page:
        raise SystemExit(f"{tpl.name}: unknown placeholder {page[page.index('<!--#'):][:30]!r}")
    page = page.replace("<!doctype html>", f"<!doctype html>\n<!-- Built by app/src/build.py from app/src/{tpl.name}. Edit the template, not this file. -->", 1)
    out = APP / OUT_NAME.get(tpl.name, tpl.name)
    out.write_text(page)
    print("built", out.relative_to(APP.parent), f"{len(page) / 1024:.0f} KB")
