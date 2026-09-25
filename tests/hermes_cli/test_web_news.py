"""Tests for the dashboard Command Center news feed (``GET /api/news``)."""
import asyncio
from typing import Dict, List

import pytest

from hermes_cli.web_routers import news


RSS = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>t</title>
<item><title>Older &amp; wiser</title><link>https://example.com/a</link>
<description>&lt;p&gt;Hello <![CDATA[<b>world</b>]]>&lt;/p&gt;</description>
<pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>No link</title><link>javascript:alert(1)</link></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>a</title>
<entry><title>Newest</title><link rel="alternate" href="https://example.org/n"/>
<updated>2026-09-20T12:00:00Z</updated><summary>Fresh</summary></entry>
</feed>"""


def test_parse_rss_strips_html_and_drops_unsafe_links():
    items = news.parse_feed(RSS, "Src")
    assert [i["title"] for i in items] == ["Older & wiser"]
    assert items[0]["summary"] == "Hello world"
    assert items[0]["source"] == "Src"
    assert items[0]["published"] is not None


def test_parse_atom():
    items = news.parse_feed(ATOM, "A")
    assert items[0]["link"] == "https://example.org/n"
    assert items[0]["summary"] == "Fresh"


def test_parse_rejects_dtd():
    bomb = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss><channel/></rss>'
    with pytest.raises(ValueError):
        news.parse_feed(bomb, "x")


def test_resolve_feeds_defaults_and_custom():
    assert news.resolve_news_feeds({}) == news.DEFAULT_NEWS_FEEDS
    feeds = news.resolve_news_feeds({"dashboard": {"news_feeds": [
        "https://www.example.com/rss",
        {"name": "Mine", "url": "https://x.dev/feed"},
        "file:///etc/passwd",
        42,
    ]}})
    assert feeds == [
        {"name": "example.com", "url": "https://www.example.com/rss"},
        {"name": "Mine", "url": "https://x.dev/feed"},
    ]


@pytest.fixture
def client(monkeypatch):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_endpoint_merges_sorts_and_caches(client, monkeypatch):
    monkeypatch.setattr(news, "_cache", {})
    monkeypatch.setattr(news, "load_config", lambda: {"dashboard": {"news_feeds": [
        {"name": "R", "url": "https://r.test/rss"},
        {"name": "A", "url": "https://a.test/atom"},
        {"name": "Down", "url": "https://down.test/rss"},
    ]}})
    calls = []

    async def fake_fetch(_client, feed):
        calls.append(feed["url"])
        if "down" in feed["url"]:
            return [], {**feed, "ok": False, "count": 0, "error": "boom"}
        payload = RSS if feed["url"].endswith("rss") else ATOM
        items = news.parse_feed(payload, feed["name"])
        return items, {**feed, "ok": True, "count": len(items), "error": None}

    monkeypatch.setattr(news, "_fetch_feed", fake_fetch)

    resp = client.get("/api/news")
    assert resp.status_code == 200
    data = resp.json()
    assert [i["title"] for i in data["items"]] == ["Newest", "Older & wiser"]
    assert [f["ok"] for f in data["feeds"]] == [True, True, False]
    assert len(calls) == 3

    client.get("/api/news", params={"limit": 1})
    assert len(calls) == 3, "second call should be served from cache"
    client.get("/api/news", params={"refresh": "true"})
    assert len(calls) == 6


def test_cap_per_source_preserves_diversity_without_dropping_count():
    # 20 items from one chatty source, newest-first, plus 3 from a quiet one.
    chatty = [
        {"source": "Chatty", "published": 100 - i, "link": f"https://c.test/{i}"}
        for i in range(20)
    ]
    quiet = [
        {"source": "Quiet", "published": 90 - i, "link": f"https://q.test/{i}"}
        for i in range(3)
    ]
    merged = sorted(chatty + quiet, key=lambda i: i["published"], reverse=True)

    # limit comfortably covers the diverse pool (cap-per-source + all of quiet).
    result = news._cap_per_source(merged, limit=11)

    sources = [i["source"] for i in result]
    assert sources.count("Quiet") == 3, "the quiet source must not be crowded out"
    assert sources.count("Chatty") == 8, "the chatty source must be capped, not excluded"


def test_cap_per_source_backfills_from_overflow_on_a_single_source_day():
    only_source = [
        {"source": "Solo", "published": 100 - i, "link": f"https://s.test/{i}"}
        for i in range(15)
    ]

    result = news._cap_per_source(only_source, limit=10)

    assert len(result) == 10, "a quiet news day must not return fewer than the limit"


def test_same_host_feeds_are_fetched_one_at_a_time():
    news._HOST_LOCKS.clear()
    order: List[str] = []
    concurrent_by_host: Dict[str, int] = {}
    max_concurrent_by_host: Dict[str, int] = {}

    async def fake_fetch(client, feed):
        from urllib.parse import urlparse
        host = urlparse(feed["url"]).hostname
        async with news._host_lock(feed["url"]):
            concurrent_by_host[host] = concurrent_by_host.get(host, 0) + 1
            max_concurrent_by_host[host] = max(
                max_concurrent_by_host.get(host, 0), concurrent_by_host[host]
            )
            order.append(f"start:{feed['name']}")
            await asyncio.sleep(0.05)
            order.append(f"end:{feed['name']}")
            concurrent_by_host[host] -= 1
        return [], {**feed, "ok": True, "count": 0, "error": None}

    async def run():
        feeds = [
            {"name": "A", "url": "https://same-host.test/a"},
            {"name": "B", "url": "https://same-host.test/b"},
            {"name": "C", "url": "https://other-host.test/c"},
        ]
        await asyncio.gather(*(fake_fetch(None, f) for f in feeds))

    asyncio.run(run())

    assert max_concurrent_by_host["same-host.test"] == 1, \
        "same-host feeds must never overlap in-flight"
    # A and B share a host so they must fully serialize; C is unconstrained.
    same_host_events = [e for e in order if "A" in e or "B" in e]
    assert same_host_events in (
        ["start:A", "end:A", "start:B", "end:B"],
        ["start:B", "end:B", "start:A", "end:A"],
    )


def test_endpoint_requires_token():
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")
    from hermes_cli.web_server import app

    assert TestClient(app).get("/api/news").status_code == 401
