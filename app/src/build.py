"""
Assemble app/index.html (Netlify) from app/src/body.html + app/model.json + app/sample_batch.csv.

    python model/train_export.py   # retrain + export model.json
    python app/src/build.py        # rebuild the single-file app
"""
import json
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
body = (APP / "src" / "body.html").read_text()
model = (APP / "model.json").read_text()
sample = (APP / "sample_batch.csv").read_text()

page = (body.replace("/*__MODEL__*/null", model)
            .replace('/*__SAMPLE__*/""', json.dumps(sample)))

head, rest = page.split("<header>", 1)
doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Triage: a credit pre-screener that removes clear-cut personal-loan declines from manual review. Calibo AI Academy MUC02, Batch 10.">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
{head.strip()}
</head>
<body>
<header>{rest}
</body>
</html>
"""
(APP / "index.html").write_text(doc)

# Optional: body-only copy for hosts that add their own document skeleton
if len(sys.argv) > 1:
    Path(sys.argv[1]).write_text(page)
print("built", APP / "index.html", f"{len(doc)/1024:.0f} KB")
