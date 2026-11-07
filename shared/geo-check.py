#!/usr/bin/env python3
# @nikitos-shared geo-check.py — общая версия в nikalimp/deploy-kit/shared
"""
geo-check.py — техническая проверка сайта по стандарту [[GEO-аудит]] (блок 2 и часть блока 4).

Только стандартная библиотека Python 3.9+. Ничего не устанавливать.

Использование:
  python3 geo-check.py https://example.ru            # живой сайт
  python3 geo-check.py https://example.ru --max 30   # до 30 страниц из sitemap
  python3 geo-check.py ./out --base https://example.ru   # локальная сборка (статический экспорт)
  python3 geo-check.py https://example.ru --json report.json

Что проверяет:
  • robots.txt — пускает ли AI- и поисковых ботов, есть ли Sitemap
  • sitemap.xml — число URL, lastmod
  • llms.txt / llms-full.txt — наличие и формат (H1, краткое описание, ссылки)
  • HTTPS, редиректы http→https и www→без www, HSTS, сжатие, TTFB (только для живого сайта)
  • каждая страница: статус, title, description, canonical, H1, lang, Open Graph,
    noindex, JSON-LD (типы, валидность), текст без JavaScript (слов), прямой ответ
    в первых 100 словах, даты, FAQ, внутренние ссылки, картинки без alt
  • доступность для ботов: ответ сервера на User-Agent GPTBot / YandexBot / PerplexityBot

Результат — Markdown в stdout (вставляется в отчёт) + балл технического блока 0–10.
"""
import argparse, gzip, json, os, re, ssl, sys, time, urllib.parse, urllib.request, zlib
from html.parser import HTMLParser

UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
BOTS = {
    "GPTBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "OAI-SearchBot": "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
    "PerplexityBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "ClaudeBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "YandexBot": "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    "Googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
}
AI_AGENTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Claude-SearchBot",
             "Google-Extended", "YandexBot", "YandexAdditional", "Applebot-Extended", "DeepSeekBot", "Bytespider", "CCBot"]


# ---------- загрузка ----------
class Resp:
    def __init__(self, status=0, headers=None, body=b"", url="", ttfb=None, error=None):
        self.status, self.headers, self.body, self.url, self.ttfb, self.error = status, headers or {}, body, url, ttfb, error

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _ssl_context():
    # macOS Python из python.org не видит системные сертификаты — берём certifi, если есть
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    if os.path.exists("/etc/ssl/cert.pem"):  # системный набор сертификатов macOS
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


_SSL = _ssl_context()


def fetch(url, ua=UA_BROWSER, follow=True, timeout=20):
    handlers = [urllib.request.HTTPSHandler(context=_SSL)]
    if not follow:
        handlers.append(NoRedirect)
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Encoding": "gzip, deflate", "Accept": "*/*"})
    t0 = time.time()
    try:
        r = opener.open(req, timeout=timeout)
        ttfb = time.time() - t0
        body = r.read()
        h = {k.lower(): v for k, v in r.headers.items()}
        enc = h.get("content-encoding", "")
        if enc == "gzip":
            body = gzip.decompress(body)
        elif enc == "deflate":
            body = zlib.decompress(body)
        return Resp(r.status, h, body, r.geturl(), ttfb)
    except urllib.error.HTTPError as e:
        return Resp(e.code, {k.lower(): v for k, v in e.headers.items()}, e.read() if e.fp else b"", url, time.time() - t0)
    except Exception as e:  # сеть, DNS, SSL
        return Resp(0, {}, b"", url, None, str(e))


class Source:
    """Единый интерфейс: живой сайт или локальная папка out/."""

    def __init__(self, target, base=None):
        self.local = os.path.isdir(target)
        self.root = target if self.local else None
        self.base = (base or ("https://example.ru" if self.local else target)).rstrip("/")

    def get(self, path_or_url, ua=UA_BROWSER):
        url = path_or_url if path_or_url.startswith("http") else self.base + path_or_url
        if not self.local:
            return fetch(url, ua)
        path = urllib.parse.urlparse(url).path
        cands = [path, path.rstrip("/") + "/index.html", path.rstrip("/") + ".html"]
        for c in cands:
            fp = os.path.join(self.root, c.lstrip("/"))
            if os.path.isfile(fp):
                with open(fp, "rb") as f:
                    return Resp(200, {"content-type": "text/html" if fp.endswith(".html") else "text/plain"}, f.read(), url, 0)
        return Resp(404, {}, b"", url, 0)


# ---------- разбор HTML ----------
class Page(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.meta, self.links, self.h, self.imgs, self.lang = "", {}, [], [], [], ""
        self.canon, self.jsonld, self.text, self.times = "", [], [], []
        self._stack, self._buf, self._in_title, self._in_ld, self._hcur = [], [], False, False, None
        self.details = 0

    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag == "html":
            self.lang = a.get("lang", "")
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            k = (a.get("name") or a.get("property") or "").lower()
            if k:
                self.meta[k] = a.get("content", "")
        elif tag == "link" and "canonical" in (a.get("rel") or ""):
            self.canon = a.get("href", "")
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "img":
            self.imgs.append(a.get("alt"))
        elif tag == "time":
            self.times.append(a.get("datetime", ""))
        elif tag == "details":
            self.details += 1
        elif tag in ("h1", "h2", "h3"):
            self._hcur = [tag, ""]
        elif tag == "script" and (a.get("type") or "").lower() == "application/ld+json":
            self._in_ld, self._buf = True, []
        if tag in self.SKIP:
            self._stack.append(tag)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script" and self._in_ld:
            self._in_ld = False
            self.jsonld.append("".join(self._buf))
        elif self._hcur and tag == self._hcur[0]:
            self.h.append((self._hcur[0], self._hcur[1].strip()))
            self._hcur = None
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()

    def handle_data(self, d):
        if self._in_title:
            self.title += d
        if self._in_ld:
            self._buf.append(d)
            return
        if self._hcur:
            self._hcur[1] += d
        if not self._stack and d.strip():
            self.text.append(d.strip())


def ld_types(blobs):
    types, errors = [], 0
    def walk(o):
        if isinstance(o, dict):
            t = o.get("@type")
            if t:
                types.extend(t if isinstance(t, list) else [t])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    for b in blobs:
        try:
            walk(json.loads(b))
        except Exception:
            errors += 1
    return types, errors


def analyze_page(src, url):
    r = src.get(url)
    res = {"url": url, "status": r.status}
    if r.status != 200:
        res["error"] = r.error
        return res
    p = Page()
    p.feed(r.text)
    words = " ".join(p.text).split()
    types, ld_err = ld_types(p.jsonld)
    host = urllib.parse.urlparse(src.base).netloc
    internal = [l for l in p.links if l.startswith("/") or host in l]
    first100 = " ".join(words[:100])
    res.update({
        "title": p.title.strip(), "title_len": len(p.title.strip()),
        "desc": p.meta.get("description", ""), "desc_len": len(p.meta.get("description", "")),
        "canonical": p.canon, "lang": p.lang,
        "h1": [t for h, t in p.h if h == "h1"], "h2": len([1 for h, _ in p.h if h == "h2"]),
        "og": all(k in p.meta for k in ("og:title", "og:description")), "og_image": "og:image" in p.meta,
        "noindex": "noindex" in p.meta.get("robots", "").lower(),
        "jsonld_types": sorted(set(types)), "jsonld_errors": ld_err,
        "words_no_js": len(words), "html_kb": round(len(r.body) / 1024, 1),
        "has_digits_first100": bool(re.search(r"\d", first100)),
        "dates": bool(p.times) or any(t in types for t in ("Article", "BlogPosting")) and "dateModified" in r.text,
        "faq": "FAQPage" in types or p.details > 0,
        "internal_links": len(internal), "img_total": len(p.imgs), "img_no_alt": sum(1 for a in p.imgs if not a),
        "ttfb": round(r.ttfb, 2) if r.ttfb else None,
    })
    return res


def robots_check(txt):
    groups, cur, sitemaps = {}, [], []
    for line in txt.splitlines():
        line = line.split("#")[0].strip()
        if not line or ":" not in line:
            continue
        k, v = [x.strip() for x in line.split(":", 1)]
        k = k.lower()
        if k == "user-agent":
            if cur and cur[-1][1]:
                cur = []
            cur.append([v, []])
            groups.setdefault(v.lower(), [])
            cur[-1][1] = groups[v.lower()]
        elif k in ("allow", "disallow") and cur:
            for ua, rules in cur:
                rules.append((k, v))
        elif k == "sitemap":
            sitemaps.append(v)
    def blocked(agent):
        rules = groups.get(agent.lower(), groups.get("*", []))
        return any(k == "disallow" and v == "/" for k, v in rules) and not any(k == "allow" and v == "/" for k, v in rules)
    return {a: ("закрыт" if blocked(a) else ("явно открыт" if a.lower() in groups else "открыт через *")) for a in AI_AGENTS}, sitemaps


def llms_check(txt):
    lines = txt.strip().splitlines()
    return {
        "h1": bool(lines) and lines[0].startswith("# "),
        "summary": any(l.startswith("> ") for l in lines[:6]),
        "links": len(re.findall(r"\[[^\]]+\]\((https?://[^)]+)\)", txt)),
        "sections": len([l for l in lines if l.startswith("## ")]),
        "chars": len(txt),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--base")
    ap.add_argument("--max", type=int, default=25)
    ap.add_argument("--json")
    a = ap.parse_args()
    src = Source(a.target, a.base)
    R = {"target": a.target, "base": src.base, "date": time.strftime("%Y-%m-%d"), "issues": []}
    issue = lambda sev, msg: R["issues"].append((sev, msg))

    # 1. robots
    rb = src.get("/robots.txt")
    R["robots_status"] = rb.status
    if rb.status == 200:
        R["robots"], R["sitemaps"] = robots_check(rb.text)
        for ag, st in R["robots"].items():
            if st == "закрыт" and ag in ("GPTBot", "OAI-SearchBot", "PerplexityBot", "YandexBot", "ClaudeBot"):
                issue("P1", f"robots.txt закрывает {ag}")
        if not R["sitemaps"]:
            issue("P2", "В robots.txt нет строки Sitemap")
    else:
        issue("P1", f"robots.txt недоступен ({rb.status})")

    # 2. sitemap
    sm = src.get("/sitemap.xml")
    urls = re.findall(r"<loc>\s*(.*?)\s*</loc>", sm.text) if sm.status == 200 else []
    R["sitemap_urls"], R["sitemap_lastmod"] = len(urls), sm.text.count("<lastmod>")
    if not urls:
        issue("P1", "sitemap.xml отсутствует или пуст")
    elif R["sitemap_lastmod"] < len(urls):
        issue("P3", "Не у всех URL в sitemap есть lastmod")

    # 3. llms.txt
    for f in ("/llms.txt", "/llms-full.txt"):
        r = src.get(f)
        R[f] = llms_check(r.text) if r.status == 200 else None
    if not R["/llms.txt"]:
        issue("P2", "Нет /llms.txt")
    elif not (R["/llms.txt"]["h1"] and R["/llms.txt"]["summary"]):
        issue("P3", "llms.txt не по формату llmstxt.org (нужны '# Название' и '> краткое описание')")

    # 4. сеть (только живой сайт)
    if not src.local:
        u = urllib.parse.urlparse(src.base)
        http = fetch(f"http://{u.netloc}/", follow=False)
        R["http_redirect"] = (http.status, http.headers.get("location"))
        if not (300 <= http.status < 400 and (http.headers.get("location") or "").startswith("https")):
            issue("P1", "http:// не редиректит на https://")
        alt = u.netloc[4:] if u.netloc.startswith("www.") else "www." + u.netloc
        w = fetch(f"https://{alt}/", follow=False)
        R["www_redirect"] = (w.status, w.headers.get("location"), w.error)
        if not (300 <= w.status < 400):
            issue("P2", f"https://{alt}/ не редиректит на основное зеркало ({w.status or w.error})")
        home = fetch(src.base + "/")
        R["hsts"] = "strict-transport-security" in home.headers
        R["compression"] = home.headers.get("content-encoding")
        R["server"] = home.headers.get("server")
        R["ttfb_home"] = round(home.ttfb, 2) if home.ttfb else None
        if not R["compression"]:
            issue("P3", "Нет gzip/brotli-сжатия HTML")
        if R["ttfb_home"] and R["ttfb_home"] > 0.8:
            issue("P2", f"TTFB главной {R['ttfb_home']} с (норма < 0,8 с)")
        R["bots"] = {}
        for name, ua in BOTS.items():
            r = fetch(src.base + "/", ua=ua)
            R["bots"][name] = r.status
            if r.status != 200:
                issue("P1", f"Сервер отдаёт {r.status} боту {name} (WAF/антибот?)")
        nf = fetch(src.base + "/geo-check-404-test/")
        R["status_404"] = nf.status
        if nf.status != 404:
            issue("P2", f"Несуществующая страница отдаёт {nf.status}, а не 404")

    # 5. страницы
    pages = urls[: a.max] if urls else [src.base + "/"]
    if src.local and urls:
        pages = [src.base + urllib.parse.urlparse(x).path for x in pages]
    R["pages"] = [analyze_page(src, p) for p in pages]
    titles = {}
    for p in R["pages"]:
        if p["status"] != 200:
            issue("P1", f"{p['url']} → {p['status']}")
            continue
        path = urllib.parse.urlparse(p["url"]).path
        titles.setdefault(p["title"], []).append(path)
        if not 30 <= p["title_len"] <= 65:
            issue("P3", f"{path}: title {p['title_len']} симв. (норма 30–65)")
        if not 70 <= p["desc_len"] <= 160:
            issue("P3", f"{path}: description {p['desc_len']} симв. (норма 70–160)")
        if len(p["h1"]) != 1:
            issue("P2", f"{path}: H1 = {len(p['h1'])} (нужен ровно 1)")
        if not p["canonical"]:
            issue("P2", f"{path}: нет canonical")
        if p["noindex"]:
            issue("P1", f"{path}: noindex")
        if not p["jsonld_types"]:
            issue("P2", f"{path}: нет JSON-LD")
        if p["jsonld_errors"]:
            issue("P1", f"{path}: битый JSON-LD ({p['jsonld_errors']})")
        if p["words_no_js"] < 300:
            issue("P2", f"{path}: без JS видно только {p['words_no_js']} слов")
        if not p["og_image"]:
            issue("P3", f"{path}: нет og:image")
        if p["img_no_alt"]:
            issue("P3", f"{path}: {p['img_no_alt']} картинок без alt")
    for t, ps in titles.items():
        if len(ps) > 1:
            issue("P2", f"Одинаковый title на {len(ps)} страницах: «{t[:60]}»")

    # 6. балл технического блока
    sev_w = {"P1": 2.0, "P2": 0.75, "P3": 0.2}
    uniq = {}
    for s, m in R["issues"]:
        key = re.sub(r"^/[^:]*: ", "", m)
        uniq.setdefault((s, re.sub(r"\d+", "N", key)), 0)
        uniq[(s, re.sub(r"\d+", "N", key))] += 1
    penalty = sum(sev_w[s] * min(1 + (n - 1) * 0.25, 2) for (s, _), n in uniq.items())
    R["tech_score"] = max(0, round(10 - penalty, 1))

    # ---------- вывод ----------
    out = [f"## geo-check · {src.base} · {R['date']}" + (" (локальная сборка)" if src.local else ""), ""]
    out.append(f"**Технический балл: {R['tech_score']}/10** · страниц проверено: {len(R['pages'])} · URL в sitemap: {R['sitemap_urls']}")
    out.append("")
    if not src.local:
        out += [f"- http→https: {R['http_redirect']}", f"- www-зеркало: {R['www_redirect']}",
                f"- HSTS: {R['hsts']} · сжатие: {R['compression']} · сервер: {R['server']} · TTFB главной: {R['ttfb_home']} с",
                f"- Ответ ботам: {R['bots']}", f"- 404-тест: {R['status_404']}"]
    if R.get("robots"):
        out.append("- robots.txt: " + ", ".join(f"{k} — {v}" for k, v in R["robots"].items()))
    out.append(f"- llms.txt: {R['/llms.txt']} · llms-full.txt: {'есть' if R['/llms-full.txt'] else 'нет'}")
    out += ["", "| Страница | Title | Desc | H1 | Слов без JS | JSON-LD | FAQ |", "|---|---|---|---|---|---|---|"]
    for p in R["pages"]:
        if p["status"] != 200:
            out.append(f"| {p['url']} | {p['status']} | | | | | |")
            continue
        out.append(f"| {urllib.parse.urlparse(p['url']).path} | {p['title_len']} | {p['desc_len']} | {len(p['h1'])} | {p['words_no_js']} | {', '.join(p['jsonld_types'][:6])} | {'да' if p['faq'] else '—'} |")
    out += ["", "### Проблемы", ""]
    for s in ("P1", "P2", "P3"):
        for sev, m in R["issues"]:
            if sev == s:
                out.append(f"- **{s}** {m}")
    if not R["issues"]:
        out.append("- нет")
    print("\n".join(out))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(R, f, ensure_ascii=False, indent=1, default=str)


if __name__ == "__main__":
    main()
