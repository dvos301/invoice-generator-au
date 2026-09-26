#!/usr/bin/env python3
"""Audit this site's indexability, inspect GSC, and notify IndexNow of changes."""

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://invoice-generator.com.au"
PROPERTY = ORIGIN + "/"
SITEMAP = ORIGIN + "/sitemap.xml"
DEFAULT_CREDENTIAL = Path.home() / ".config/codex/gsc/service-account.searchconsoleapi-457306.json"


def fetch(url):
    result = subprocess.run(
        ["curl", "-sS", "-i", "--max-time", "25", url],
        capture_output=True, text=True, check=True,
    )
    remaining = result.stdout
    headers = ""
    # curl may include an HTTP proxy's CONNECT response before the origin response.
    while remaining.startswith("HTTP/"):
        split = re.search(r"\r?\n\r?\n", remaining)
        if not split:
            break
        headers, remaining = remaining[:split.start()], remaining[split.end():]
    match = re.match(r"HTTP/\S+\s+(\d{3})", headers)
    if not match:
        raise ValueError(f"No HTTP status for {url}")
    return int(match.group(1)), headers.lower(), remaining


def sitemap_urls():
    status, _, body = fetch(SITEMAP)
    if status != 200:
        raise ValueError(f"Sitemap returned HTTP {status}")
    root = ET.fromstring(body)
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    return {node.text for node in root.findall("s:url/s:loc", ns) if node.text}


def normalize(value):
    url = value if value.startswith("https://") else ORIGIN + "/" + value.lstrip("/")
    if not url.startswith(PROPERTY) or "?" in url or "#" in url:
        raise ValueError(f"Only clean URLs on {PROPERTY} are accepted: {value}")
    return url


def audit_one(url, listed):
    errors = []
    if url not in listed:
        errors.append("absent from sitemap")
    try:
        status, headers, html = fetch(url)
        if status != 200:
            errors.append(f"HTTP {status}")
        canonicals = re.findall(r'<link\b[^>]*\brel=["\']canonical["\'][^>]*\bhref=["\']([^"\']+)', html, re.I)
        if canonicals != [url]:
            errors.append(f"canonical {canonicals or 'missing'}")
        if re.search(r'<meta\b[^>]*\bname=["\']robots["\'][^>]*\bcontent=["\'][^"\']*noindex', html, re.I) or re.search(r"x-robots-tag:[^\r\n]*noindex", headers):
            errors.append("noindex")
    except Exception as exc:
        errors.append(str(exc))
    return url, errors


def audit(urls, listed):
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda url: audit_one(url, listed), urls))
    for url, errors in results:
        print(("FAIL " + ", ".join(errors) if errors else "PASS") + " " + url)
    return not any(errors for _, errors in results)


def credential():
    path = Path(os.environ.get("GSC_SERVICE_ACCOUNT", DEFAULT_CREDENTIAL))
    if not path.is_file():
        raise ValueError(f"GSC credential missing: {path}")
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        str(path), scopes=["https://www.googleapis.com/auth/webmasters"]
    )
    return build("searchconsole", "v1", credentials=creds, cache_discovery=False)


def indexnow_key():
    keys = [p for p in ROOT.glob("*.txt") if re.fullmatch(r"[A-Za-z0-9-]{8,128}\.txt", p.name) and p.read_text().strip() == p.stem]
    if len(keys) != 1:
        raise ValueError("Expected one root IndexNow key file named <key>.txt")
    return keys[0].stem


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["audit", "inspect", "submit-sitemap", "indexnow"])
    parser.add_argument("urls", nargs="*", help="Site paths or full URLs")
    parser.add_argument("--all", action="store_true", help="Use every URL in the sitemap")
    parser.add_argument("--file", type=Path, help="Read one site URL or path per line")
    parser.add_argument("--dry-run", action="store_true", help="Validate without IndexNow submission")
    args = parser.parse_args()
    if args.all and (args.urls or args.file):
        parser.error("Use --all or specific URLs/--file, not both")
    if args.action in ("inspect", "indexnow", "audit") and not (args.all or args.urls or args.file):
        parser.error("Specify URLs, --file, or --all")
    listed = sitemap_urls() if args.action != "submit-sitemap" else set()
    values = list(args.urls)
    if args.file:
        values.extend(line.strip() for line in args.file.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#"))
    urls = sorted(listed) if args.all else list(dict.fromkeys(normalize(v) for v in values))
    if args.action in ("inspect", "indexnow", "audit") and not urls:
        parser.error("No URLs selected")

    if args.action == "audit":
        return 0 if audit(urls, listed) else 1
    if args.action == "inspect":
        service = credential()
        for url in urls:
            try:
                data = service.urlInspection().index().inspect(body={"inspectionUrl": url, "siteUrl": PROPERTY}).execute()
                result = data.get("inspectionResult", {}).get("indexStatusResult", {})
                print(json.dumps({"url": url, **{k: result.get(k) for k in ("verdict", "coverageState", "lastCrawlTime", "googleCanonical", "userCanonical")}}))
            except Exception as exc:
                print(json.dumps({"url": url, "error": str(exc)}))
        return 0
    if args.action == "submit-sitemap":
        credential().sitemaps().submit(siteUrl=PROPERTY, feedpath=SITEMAP).execute()
        print(f"Submitted {SITEMAP} to {PROPERTY}")
        return 0
    if not audit(urls, listed):
        return 1
    key = indexnow_key()
    key_url = f"{ORIGIN}/{key}.txt"
    status, _, body = fetch(key_url)
    if status != 200 or body.strip() != key:
        raise ValueError("Live IndexNow key file is missing or invalid; deploy it before submitting")
    if args.dry_run:
        print(f"Dry run: {len(urls)} verified URLs ready for IndexNow")
        return 0
    payload = json.dumps({"host": "invoice-generator.com.au", "key": key, "keyLocation": key_url, "urlList": urls}).encode()
    request = urllib.request.Request("https://api.indexnow.org/indexnow", data=payload, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            detail = "key validation pending" if response.status == 202 else "received"
            print(f"IndexNow HTTP {response.status}: {len(urls)} URLs {detail}")
    except urllib.error.HTTPError as exc:
        print(f"IndexNow HTTP {exc.code}: {exc.read().decode(errors='replace')[:300]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
