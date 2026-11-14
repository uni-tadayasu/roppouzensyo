#!/usr/bin/env python3
"""Build the six-code offline snapshot from the e-Gov Law API Version 2."""

from __future__ import annotations

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API = "https://laws.e-gov.go.jp/api/2/law_data/"
SOURCE = "https://laws.e-gov.go.jp/law/"
LAWS = {
    "constitution": ("321CONSTITUTION", "日本国憲法"),
    "civil": ("129AC0000000089", "民法"),
    "commercial": ("132AC0000000048", "商法"),
    "criminal": ("140AC0000000045", "刑法"),
    "civil-procedure": ("408AC0000000109", "民事訴訟法"),
    "criminal-procedure": ("323AC0000000131", "刑事訴訟法"),
}
GROUPS = {"Part", "Chapter", "Section", "Subsection", "Division"}
ITEMS = {"Item", *(f"Subitem{level}" for level in range(1, 11))}
JST = timezone(timedelta(hours=9))


def children(node, *tags):
    return [
        child for child in node["children"]
        if isinstance(child, dict) and (not tags or child["tag"] in tags)
    ]


def first(node, tag):
    return next(iter(children(node, tag)), None)


def text(node, reading=False):
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    tag = node["tag"]
    if tag == "Rt":
        return "".join(text(child, reading) for child in node["children"]) if reading else ""
    if tag == "Ruby" and reading:
        ruby_text = "".join(text(child, reading) for child in children(node, "Rt"))
        if ruby_text:
            return ruby_text
    if any(child["tag"] == "Column" for child in children(node)):
        return "　".join(text(child, reading) for child in children(node, "Column"))
    return "".join(text(child, reading) for child in node["children"])


def caption(node, tag):
    label = text(first(node, tag))
    if label.startswith("（") and label.endswith("）"):
        return label[1:-1]
    return label


def number(node):
    value = node["attr"]["Num"]
    if not re.fullmatch(r"\d+(?:_\d+)*(?::\d+(?:_\d+)*)?", value):
        raise ValueError(f"Unsupported {node['tag']} number: {value!r}")
    return value.replace(":", "-")


def make_part(part_id, label, display, reading, depth):
    part = {"id": part_id, "label": label, "text": display, "depth": depth}
    if reading != display:
        part["reading"] = reading
    return part


def table_parts(node, part_id, depth):
    parts = []
    label = text(first(node, "TableStructTitle"))
    table = first(node, "Table")
    if table is None:
        raise ValueError("TableStruct is missing its Table")
    for position, row in enumerate(children(table, "TableHeaderRow", "TableRow"), 1):
        cells = children(row, "TableHeaderColumn", "TableColumn")
        part = make_part(
            f"{part_id}.{position}",
            f"{label or '表'} 第{position}行",
            "　｜　".join(text(cell) for cell in cells),
            "。".join(text(cell, reading=True) for cell in cells),
            depth,
        )
        parts.append(part)
    return parts


def extract_parts(node, part_id, depth):
    tag = node["tag"]
    display_number = number(node)
    if tag == "Paragraph":
        label = f"第{display_number}項"
        heading = caption(node, "ParagraphCaption")
        if heading:
            label = f"{label}（{heading}）"
    elif tag == "Item":
        label = f"第{display_number}号"
    else:
        label = text(first(node, f"{tag}Title")) or display_number

    sentence = first(node, f"{tag}Sentence")
    display = text(sentence)
    reading = text(sentence, reading=True)
    parts = [make_part(part_id, label, display, reading, depth)] if display else []
    table_count = 0
    for child in children(node):
        child_tag = child["tag"]
        if child_tag in ITEMS:
            parts.extend(extract_parts(child, f"{part_id}.{number(child)}", depth + 1))
        elif child_tag == "TableStruct":
            table_count += 1
            parts.extend(table_parts(child, f"{part_id}.t{table_count}", depth + 1))
        elif child_tag not in {f"{tag}Title", f"{tag}Sentence", "ParagraphNum", "ParagraphCaption"}:
            raise ValueError(f"Unsupported body element: {tag}/{child_tag}")
    return parts


def document_entry(entry_id, title, headings, paragraphs, *, supplemental=False, article_caption=""):
    parts = [part for node in paragraphs for part in extract_parts(node, number(node), 0)]
    if not parts:
        raise ValueError(f"No text for {entry_id}: {title}")
    if len(parts) != len({part["id"] for part in parts}):
        raise ValueError(f"Repeated part number in {entry_id}: {title}")
    return {
        "id": entry_id,
        "title": title,
        "caption": article_caption,
        "chapter": "／".join(headings),
        "supplementary": supplemental,
        "parts": parts,
    }


def extract_articles(node, headings=(), supplement_id=""):
    parent = node["tag"]
    for child in children(node):
        tag = child["tag"]
        if tag in GROUPS:
            title = text(first(child, f"{tag}Title"))
            yield from extract_articles(child, (*headings, title), supplement_id)
        elif tag == "Article":
            article_id = supplement_id + number(child)
            unexpected = [n["tag"] for n in children(child) if n["tag"] not in {"ArticleTitle", "ArticleCaption", "Paragraph"}]
            if unexpected:
                raise ValueError(f"Unsupported Article element in {article_id}: {unexpected}")
            yield document_entry(
                article_id,
                text(first(child, "ArticleTitle")),
                headings,
                children(child, "Paragraph"),
                supplemental=bool(supplement_id),
                article_caption=caption(child, "ArticleCaption"),
            )
        elif tag not in {f"{parent}Title", "Paragraph", "SupplProvisionLabel"}:
            raise ValueError(f"Unsupported provision element: {parent}/{tag}")


def extract_supplement(node, occurrence):
    amendment_law = node["attr"].get("AmendLawNum", "")
    digest = hashlib.sha256(amendment_law.encode("utf-8")).hexdigest()[:12] if amendment_law else "original"
    supplement_id = f"s-{digest}-"
    if occurrence > 1:
        supplement_id = f"{supplement_id}{occurrence}-"
    supplement_title = "附則"
    if amendment_law:
        supplement_title += f"（{amendment_law}）"
    if node["attr"].get("Extract") == "true":
        supplement_title += " 抄"
    paragraphs = children(node, "Paragraph")
    if paragraphs:
        yield document_entry(supplement_id + "text", "附則本文", (supplement_title,), paragraphs, supplemental=True)
    yield from extract_articles(node, (supplement_title,), supplement_id)


def transform(slug, law_id, expected_title, data):
    law_info = data["law_info"]
    revision = data["revision_info"]
    if law_info["law_id"] != law_id or revision["law_title"] != expected_title:
        raise ValueError(f"Unexpected law returned for {slug}")
    if revision["current_revision_status"] != "CurrentEnforced":
        raise ValueError(f"API did not return the current enforced revision of {expected_title}")
    if data.get("attached_files_info"):
        raise ValueError(f"{expected_title} contains attachments requiring offline packaging")
    law_body = first(data["law_full_text"], "LawBody")
    main = first(law_body, "MainProvision")
    main_articles = list(extract_articles(main))
    if not main_articles or main_articles[0]["id"] != "1":
        raise ValueError(f"Main provisions missing for {expected_title}")

    articles = []
    enactment = children(law_body, "EnactStatement")
    if enactment:
        articles.append({
            "id": "enactment",
            "title": "制定文",
            "caption": "",
            "chapter": "制定文",
            "supplementary": False,
            "parts": [make_part(str(index), f"第{index}段落", text(line), text(line, reading=True), 0)
                      for index, line in enumerate(enactment, 1)],
        })
    preamble = first(law_body, "Preamble")
    if preamble is not None:
        articles.append(document_entry("preamble", "前文", ("前文",), children(preamble, "Paragraph")))
    articles.extend(main_articles)
    amendments = {}
    for supplement in children(law_body, "SupplProvision"):
        amendment = supplement["attr"].get("AmendLawNum", "")
        amendments[amendment] = amendments.get(amendment, 0) + 1
        articles.extend(extract_supplement(supplement, amendments[amendment]))
    if len(articles) != len({entry["id"] for entry in articles}):
        raise ValueError(f"Repeated article number in {expected_title}")
    metadata = {
        "id": slug,
        "title": expected_title,
        "number": law_info["law_num"],
        "source": SOURCE + law_id,
        "officialId": law_id,
        "revision": revision["law_revision_id"],
        "enforced": revision["amendment_enforcement_date"],
        "sourceUpdated": revision["updated"],
        "articles": len(main_articles),
        "totalArticles": len(articles),
    }
    return metadata, {**metadata, "articles": articles}


def fetch(law_id, source_dir):
    if source_dir:
        with (source_dir / f"{law_id}.json").open(encoding="utf-8") as file:
            return json.load(file)
    request = Request(API + law_id, headers={"Accept": "application/json", "User-Agent": "OpenRoppou/1.0"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=45) as response:
                return json.load(response)
        except HTTPError as error:
            if attempt == 2 or error.code not in {408, 429, 500, 502, 503, 504}:
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        sleep(2 ** attempt)


def build(slug_and_source, source_dir):
    slug, (law_id, title) = slug_and_source
    return transform(slug, law_id, title, fetch(law_id, source_dir))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "docs/data")
    parser.add_argument("--source-dir", type=Path, help="Read previously downloaded e-Gov responses from this directory")
    options = parser.parse_args()
    options.output.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as executor:
        laws = list(executor.map(lambda law: build(law, options.source_dir), LAWS.items()))
    catalog = {
        "updated": datetime.now(JST).date().isoformat(),
        "source": "e-Gov法令検索",
        "terms": "https://laws.e-gov.go.jp/terms",
        "laws": [metadata for metadata, _ in laws],
    }
    # Validate all API data and finish serializing before replacing the previous snapshot.
    with TemporaryDirectory(prefix=".law-update-", dir=options.output) as temp_dir:
        staging = Path(temp_dir)
        filenames = []
        for metadata, law in laws:
            filename = f"{metadata['id']}.json"
            write_json(staging / filename, law)
            filenames.append(filename)
            print(f"{metadata['title']}: {metadata['articles']} 本則 / {metadata['totalArticles']} 収録項目")
        write_json(staging / "catalog.json", catalog)
        for filename in [*filenames, "catalog.json"]:
            (staging / filename).replace(options.output / filename)


if __name__ == "__main__":
    main()
