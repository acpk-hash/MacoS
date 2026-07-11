//! Literature search (v0.8) + detailed analysis (v0.9).
//!
//! Sources (no credentials required, called from Rust to avoid webview CORS):
//!   - arXiv  `https://export.arxiv.org/api/query` — Atom XML, parsed with a
//!     small hand-rolled extractor (no extra XML dependency).
//!   - OpenAlex `https://api.openalex.org/works` — JSON; abstracts arrive as an
//!     inverted index and are reconstructed locally.
//!   - DBLP `https://dblp.org/search/publ/api` — JSON, one request per selected
//!     venue stream (`streamid:conf/crypto:` …), restricted to a whitelist of
//!     nine crypto/security top venues and sorted newest-first.
//!   - IACR ePrint `https://eprint.iacr.org/search?q=…` — HTML result list,
//!     parsed with the same hand-rolled extractor (id/title/authors/abstract).
//!
//! Full text policy: only openly available versions are fetched. For DBLP /
//! OpenAlex hits the analyzer resolves an open version (arXiv id in the ee/doi
//! link, else an arXiv title match, else an ePrint title match); paywalled
//! bodies are never fetched — such papers fall back to metadata only, and the
//! note says so.
//!
//! Analysis (v0.9): for each selected arXiv paper the backend fetches the
//! ar5iv HTML full text (fallback: the arXiv `/abs/` page; final fallback:
//! abstract only, noted in the report), extracts figure image URLs + captions
//! and open-source code links (github/gitlab/…), and feeds everything into the
//! existing relay chat path (`providers::resolve_creds` + `relay::chat_stream`)
//! with a strict per-paper report template. The result is returned in one shot
//! together with the per-paper figures/links so the frontend can render images
//! inline. Credentials never appear in logs or error strings.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::AppState;

/// Outbound HTTP timeout for the free literature APIs.
const HTTP_TIMEOUT_SECS: u64 = 20;
/// Outbound HTTP timeout for full-text (ar5iv / arXiv abs) fetches.
const FULLTEXT_FETCH_TIMEOUT_SECS: u64 = 25;
/// Per-paper abstract cap inside the analysis prompt (chars).
const ABSTRACT_PROMPT_CAP: usize = 2000;
/// Per-paper full-text cap (chars) when stored after fetching.
const FULLTEXT_PER_PAPER_CAP: usize = 20_000;
/// Total full-text budget across all papers inside one prompt (chars).
const FULLTEXT_TOTAL_CAP: usize = 60_000;
/// Max figures extracted per paper (URL + caption).
const MAX_FIGURES_PER_PAPER: usize = 8;
/// Max open-source code links reported per paper.
const MAX_CODE_LINKS_PER_PAPER: usize = 5;
/// Default analysis instruction when the user leaves it empty.
const DEFAULT_INSTRUCTION: &str = "按标准模板逐篇详细分析这些文献，并给出横向对比与研究缺口";

// -- Unified paper shape -------------------------------------------------------

/// One search hit, unified across sources.
#[derive(Debug, Clone, Serialize)]
pub struct LitPaper {
    /// Source-native id (arXiv id like `2101.00001v2`, OpenAlex `W...`).
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    /// Publication year as a string ("" when unknown).
    pub year: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    /// Best link to the full text / landing page.
    pub url: String,
    /// "arxiv" | "openalex" | "dblp" | "eprint"
    pub source: String,
    /// Venue badge for DBLP hits (e.g. "CRYPTO"), "" for other sources.
    #[serde(default)]
    pub venue: String,
    /// Bare DOI (e.g. "10.1007/…"), "" when unknown.
    #[serde(default)]
    pub doi: String,
}

/// Paper payload accepted by `lit_analyze` (subset the frontend checks send).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LitPaperInput {
    pub title: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub year: String,
    #[serde(default, rename = "abstract")]
    pub abstract_text: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub doi: String,
}

/// One figure extracted from the ar5iv HTML (absolute image URL + caption).
#[derive(Debug, Clone, Serialize)]
pub struct LitFigure {
    pub url: String,
    pub caption: String,
}

/// Per-paper material gathered before analysis (returned to the frontend so
/// figures can be rendered inline; the raw full text stays backend-side).
#[derive(Debug, Clone, Default, Serialize)]
pub struct LitPaperExtras {
    pub title: String,
    /// Human-readable material level, e.g. "全文（ar5iv HTML 抓取）" or
    /// "仅摘要（全文抓取失败）".
    pub note: String,
    pub code_links: Vec<String>,
    pub figures: Vec<LitFigure>,
    /// Fetched plain text (prompt-side only; not sent to the frontend).
    #[serde(skip)]
    pub fulltext: String,
}

/// Result of `lit_analyze`: the Markdown report plus per-paper extras.
#[derive(Debug, Clone, Serialize)]
pub struct LitAnalyzeResult {
    pub analysis: String,
    pub papers: Vec<LitPaperExtras>,
}

// -- Tiny XML helpers (arXiv Atom) ---------------------------------------------

/// Unescape the predefined XML entities (order matters: `&amp;` last).
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Collapse all whitespace runs (arXiv wraps titles/summaries across lines).
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Inner contents of every `<tag ...>...</tag>` occurrence (non-nested tags).
fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open_plain = format!("<{}>", tag);
    let open_attr = format!("<{} ", tag);
    let close = format!("</{}>", tag);
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < xml.len() {
        let rest = &xml[pos..];
        let hit = match (rest.find(&open_plain), rest.find(&open_attr)) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => break,
        };
        let tag_start = pos + hit;
        let Some(gt) = xml[tag_start..].find('>') else { break };
        let content_start = tag_start + gt + 1;
        let Some(rel_end) = xml[content_start..].find(&close) else { break };
        out.push(&xml[content_start..content_start + rel_end]);
        pos = content_start + rel_end + close.len();
    }
    out
}

/// Inner text of the first `<tag ...>...</tag>` in `block`.
fn xml_tag_text(block: &str, tag: &str) -> Option<String> {
    xml_blocks(block, tag).first().map(|s| s.to_string())
}

/// Value of `name="..."` inside a single tag string.
fn xml_attr_value(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{}=\"", name);
    let i = tag.find(&needle)? + needle.len();
    let j = tag[i..].find('"')? + i;
    Some(xml_unescape(&tag[i..j]))
}

/// Find the `<link title="pdf" href="...">` inside an arXiv entry.
fn arxiv_pdf_link(entry: &str) -> Option<String> {
    let mut pos = 0;
    while let Some(hit) = entry[pos..].find("<link") {
        let start = pos + hit;
        let end = entry[start..].find('>')? + start;
        let tag = &entry[start..=end];
        if tag.contains("title=\"pdf\"") {
            if let Some(href) = xml_attr_value(tag, "href") {
                return Some(href);
            }
        }
        pos = end + 1;
    }
    None
}

/// Parse an arXiv Atom response into unified papers.
pub(crate) fn parse_arxiv_atom(xml: &str) -> Vec<LitPaper> {
    let mut out = Vec::new();
    for entry in xml_blocks(xml, "entry") {
        let title = collapse_ws(&xml_unescape(
            &xml_tag_text(entry, "title").unwrap_or_default(),
        ));
        if title.is_empty() {
            continue;
        }
        let abs_url = xml_unescape(xml_tag_text(entry, "id").unwrap_or_default().trim());
        let id = abs_url
            .split("/abs/")
            .nth(1)
            .unwrap_or(&abs_url)
            .to_string();
        let authors = xml_blocks(entry, "author")
            .iter()
            .filter_map(|a| xml_tag_text(a, "name"))
            .map(|n| collapse_ws(&xml_unescape(&n)))
            .filter(|n| !n.is_empty())
            .collect::<Vec<_>>();
        let published = xml_tag_text(entry, "published").unwrap_or_default();
        let year: String = published.trim().chars().take(4).collect();
        let summary = collapse_ws(&xml_unescape(
            &xml_tag_text(entry, "summary").unwrap_or_default(),
        ));
        let url = arxiv_pdf_link(entry).unwrap_or_else(|| abs_url.clone());
        out.push(LitPaper {
            id,
            title,
            authors,
            year,
            abstract_text: summary,
            url,
            source: "arxiv".to_string(),
            venue: String::new(),
            doi: String::new(),
        });
    }
    out
}

// -- OpenAlex JSON parsing -----------------------------------------------------

/// Rebuild the abstract text from OpenAlex's `abstract_inverted_index`.
fn reconstruct_abstract(idx: Option<&Value>) -> String {
    let Some(map) = idx.and_then(|v| v.as_object()) else {
        return String::new();
    };
    let mut slots: Vec<(usize, &str)> = Vec::new();
    for (word, positions) in map {
        if let Some(arr) = positions.as_array() {
            for p in arr {
                if let Some(n) = p.as_u64() {
                    slots.push((n as usize, word.as_str()));
                }
            }
        }
    }
    slots.sort_by_key(|(i, _)| *i);
    slots
        .into_iter()
        .map(|(_, w)| w)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse an OpenAlex `/works` response into unified papers.
pub(crate) fn parse_openalex_json(body: &str) -> Result<Vec<LitPaper>, String> {
    let v: Value =
        serde_json::from_str(body).map_err(|e| format!("OpenAlex 响应解析失败: {e}"))?;
    let results = v
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "OpenAlex 响应缺少 results 字段".to_string())?;

    let mut out = Vec::new();
    for w in results {
        let title = w
            .get("display_name")
            .or_else(|| w.get("title"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let id_url = w.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let id = id_url.rsplit('/').next().unwrap_or(id_url).to_string();
        let year = w
            .get("publication_year")
            .and_then(|y| y.as_i64())
            .map(|y| y.to_string())
            .unwrap_or_default();
        let mut authors = Vec::new();
        if let Some(arr) = w.get("authorships").and_then(|a| a.as_array()) {
            for a in arr {
                if let Some(name) = a
                    .pointer("/author/display_name")
                    .and_then(|n| n.as_str())
                {
                    authors.push(name.to_string());
                }
            }
        }
        let abstract_text = reconstruct_abstract(w.get("abstract_inverted_index"));
        let doi_url = w
            .get("doi")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let doi = doi_url
            .as_deref()
            .map(|u| u.trim_start_matches("https://doi.org/").to_string())
            .unwrap_or_default();
        let url = doi_url
            .or_else(|| {
                w.pointer("/primary_location/landing_page_url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| id_url.to_string());
        out.push(LitPaper {
            id,
            title,
            authors,
            year,
            abstract_text,
            url,
            source: "openalex".to_string(),
            venue: String::new(),
            doi,
        });
    }
    Ok(out)
}

// -- DBLP (crypto/security top-venue whitelist) ----------------------------------

/// One whitelisted DBLP venue: frontend key, DBLP stream id, short badge label.
pub(crate) struct DblpVenue {
    pub key: &'static str,
    pub stream: &'static str,
    pub label: &'static str,
}

/// The nine crypto/security venues `lit_search` is allowed to return.
pub(crate) const DBLP_VENUES: &[DblpVenue] = &[
    DblpVenue { key: "crypto", stream: "conf/crypto", label: "CRYPTO" },
    DblpVenue { key: "eurocrypt", stream: "conf/eurocrypt", label: "EUROCRYPT" },
    DblpVenue { key: "asiacrypt", stream: "conf/asiacrypt", label: "ASIACRYPT" },
    DblpVenue { key: "sp", stream: "conf/sp", label: "IEEE S&P" },
    DblpVenue { key: "ccs", stream: "conf/ccs", label: "CCS" },
    DblpVenue { key: "uss", stream: "conf/uss", label: "USENIX Security" },
    DblpVenue { key: "ndss", stream: "conf/ndss", label: "NDSS" },
    DblpVenue { key: "tifs", stream: "journals/tifs", label: "IEEE TIFS" },
    DblpVenue { key: "tdsc", stream: "journals/tdsc", label: "IEEE TDSC" },
];

/// Whitelist lookup by DBLP record key (e.g. "conf/crypto/CramerD98").
fn venue_of_dblp_key(rec_key: &str) -> Option<&'static DblpVenue> {
    DBLP_VENUES
        .iter()
        .find(|v| rec_key.starts_with(v.stream) && rec_key[v.stream.len()..].starts_with('/'))
}

/// DBLP's XML→JSON conversion collapses single-element lists into an object;
/// treat both shapes as "a list of values".
fn json_items(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(other) => vec![other],
        None => Vec::new(),
    }
}

/// Parse one DBLP `/search/publ/api?format=json` response. Hits whose record
/// key falls outside the venue whitelist are dropped.
pub(crate) fn parse_dblp_json(body: &str) -> Result<Vec<LitPaper>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("DBLP 响应解析失败: {e}"))?;
    let hits = v
        .pointer("/result/hits")
        .ok_or_else(|| "DBLP 响应缺少 hits 字段".to_string())?;
    let mut out = Vec::new();
    for hit in json_items(hits.get("hit")) {
        let Some(info) = hit.get("info") else { continue };
        let rec_key = info.get("key").and_then(|k| k.as_str()).unwrap_or("");
        let Some(venue) = venue_of_dblp_key(rec_key) else { continue };
        let title = info
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .trim_end_matches('.')
            .to_string();
        if title.is_empty() {
            continue;
        }
        let authors = json_items(info.pointer("/authors/author"))
            .into_iter()
            .filter_map(|a| {
                a.get("text")
                    .and_then(|t| t.as_str())
                    .or_else(|| a.as_str())
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let year = info
            .get("year")
            .and_then(|y| y.as_str())
            .unwrap_or("")
            .to_string();
        let doi = info
            .get("doi")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        let ee = json_items(info.get("ee"))
            .into_iter()
            .filter_map(|e| e.as_str())
            .next()
            .unwrap_or("")
            .to_string();
        let url = if !ee.is_empty() {
            ee
        } else if !doi.is_empty() {
            format!("https://doi.org/{doi}")
        } else {
            info.get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string()
        };
        out.push(LitPaper {
            id: rec_key.to_string(),
            title,
            authors,
            year,
            abstract_text: String::new(), // DBLP carries no abstracts.
            url,
            source: "dblp".to_string(),
            venue: venue.label.to_string(),
            doi,
        });
    }
    Ok(out)
}

/// Dedup by id, sort newest-first (recency preference), cap at `limit`.
pub(crate) fn dedup_recent_first(mut papers: Vec<LitPaper>, limit: usize) -> Vec<LitPaper> {
    let mut seen = std::collections::HashSet::new();
    papers.retain(|p| seen.insert(p.id.clone()));
    papers.sort_by_key(|p| std::cmp::Reverse(p.year.parse::<i32>().unwrap_or(0)));
    papers.truncate(limit);
    papers
}

/// Search DBLP restricted to the whitelisted venues: one request per selected
/// stream (`streamid:` facet), merged newest-first. `venue_keys` empty = all.
async fn search_dblp(
    query: &str,
    venue_keys: &[String],
    limit: u32,
) -> Result<Vec<LitPaper>, String> {
    let selected: Vec<&DblpVenue> = if venue_keys.is_empty() {
        DBLP_VENUES.iter().collect()
    } else {
        DBLP_VENUES
            .iter()
            .filter(|v| venue_keys.iter().any(|k| k == v.key))
            .collect()
    };
    if selected.is_empty() {
        return Err("未选择有效的 DBLP 会议/期刊".to_string());
    }
    let client = lit_client()?;
    let fetches = selected.iter().map(|v| {
        let client = client.clone();
        let q = format!("{} streamid:{}:", query, v.stream);
        let h = limit.to_string();
        async move {
            let resp = client
                .get("https://dblp.org/search/publ/api")
                .query(&[("q", q.as_str()), ("format", "json"), ("h", h.as_str())])
                .send()
                .await
                .map_err(|e| format!("DBLP 请求失败: {e}"))?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| format!("DBLP 读取失败: {e}"))?;
            if !status.is_success() {
                return Err(format!("DBLP HTTP {}", status.as_u16()));
            }
            parse_dblp_json(&text)
        }
    });
    let results = futures_util::future::join_all(fetches).await;
    let mut papers = Vec::new();
    let mut first_err: Option<String> = None;
    for r in results {
        match r {
            Ok(mut v) => papers.append(&mut v),
            Err(e) => first_err = first_err.or(Some(e)),
        }
    }
    if papers.is_empty() {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    Ok(dedup_recent_first(papers, limit as usize))
}

// -- IACR ePrint ------------------------------------------------------------------

/// Parse the ePrint `/search?q=…` HTML result list. Each hit is anchored by an
/// `<a title="YYYY/NNN" class="paperlink" href="/YYYY/NNN">` link followed by
/// `<strong>title</strong>`, an author span (`fst-italic`) and a
/// `search-abstract` paragraph.
pub(crate) fn parse_eprint_html(html: &str) -> Vec<LitPaper> {
    const ANCHOR: &str = "class=\"paperlink\"";
    let mut out = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut pos = 0;
    while let Some(hit) = html[pos..].find(ANCHOR) {
        starts.push(pos + hit);
        pos = pos + hit + ANCHOR.len();
    }
    for (i, &at) in starts.iter().enumerate() {
        let seg_end = starts.get(i + 1).copied().unwrap_or(html.len());
        // Enclosing <a …> tag around the paperlink class → href gives the id.
        let Some(tag_start) = html[..at].rfind("<a ") else { continue };
        let Some(tag_gt) = html[tag_start..seg_end].find('>') else { continue };
        let tag = &html[tag_start..tag_start + tag_gt + 1];
        let Some(href) = xml_attr_value(tag, "href") else { continue };
        let id = href.trim_matches('/').to_string();
        // id shape: "YYYY/NNN".
        let year: String = id.chars().take(4).collect();
        if id.len() < 6 || !year.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let seg = &html[at..seg_end];
        let title = xml_tag_text(seg, "strong")
            .map(|t| collapse_ws(&xml_unescape(&strip_tags(&t))))
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let authors = seg
            .find("class=\"fst-italic\">")
            .and_then(|a| {
                let rest = &seg[a + "class=\"fst-italic\">".len()..];
                rest.find("</span>").map(|e| &rest[..e])
            })
            .map(|s| {
                collapse_ws(&xml_unescape(&strip_tags(s)))
                    .split(',')
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let abstract_text = seg
            .find("search-abstract\">")
            .and_then(|a| {
                let rest = &seg[a + "search-abstract\">".len()..];
                rest.find("</p>").map(|e| &rest[..e])
            })
            .map(|s| collapse_ws(&xml_unescape(&strip_tags(s))))
            .unwrap_or_default();
        out.push(LitPaper {
            url: format!("https://eprint.iacr.org/{id}"),
            id,
            title,
            authors,
            year,
            abstract_text,
            source: "eprint".to_string(),
            venue: String::new(),
            doi: String::new(),
        });
    }
    out
}

/// Search the IACR Cryptology ePrint Archive (HTML result list).
async fn search_eprint(query: &str, limit: u32) -> Result<Vec<LitPaper>, String> {
    let resp = lit_client()?
        .get("https://eprint.iacr.org/search")
        .query(&[("q", query)])
        .send()
        .await
        .map_err(|e| format!("ePrint 请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("ePrint 读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("ePrint HTTP {}", status.as_u16()));
    }
    let mut papers = parse_eprint_html(&text);
    papers.truncate(limit as usize);
    Ok(papers)
}

// -- HTTP search -----------------------------------------------------------------

fn lit_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("agentboard/0.8 (literature search)")
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {e}"))
}

async fn search_arxiv(query: &str, limit: u32) -> Result<Vec<LitPaper>, String> {
    search_arxiv_raw(&format!("all:{}", query), limit).await
}

/// arXiv query with a caller-built `search_query` (e.g. `ti:"…"` title match).
async fn search_arxiv_raw(search_query: &str, limit: u32) -> Result<Vec<LitPaper>, String> {
    let resp = lit_client()?
        .get("https://export.arxiv.org/api/query")
        .query(&[
            ("search_query", search_query.to_string()),
            ("start", "0".to_string()),
            ("max_results", limit.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("arXiv 请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("arXiv 读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("arXiv HTTP {}", status.as_u16()));
    }
    Ok(parse_arxiv_atom(&text))
}

async fn search_openalex(query: &str, limit: u32) -> Result<Vec<LitPaper>, String> {
    let resp = lit_client()?
        .get("https://api.openalex.org/works")
        .query(&[
            ("search", query.to_string()),
            ("per-page", limit.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("OpenAlex 请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("OpenAlex 读取失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("OpenAlex HTTP {}", status.as_u16()));
    }
    parse_openalex_json(&text)
}

// -- Full-text fetch + extraction (v0.9) -----------------------------------------

/// Truncate to `cap` chars, appending a marker when content was dropped.
fn truncate_chars(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let mut t: String = s.chars().take(cap).collect();
    t.push_str("\n…（已截断）");
    t
}

/// Remove every `<tag ...>...</tag>` block, content included (script/style/…).
fn remove_blocks(html: &str, tag: &str) -> String {
    let open_plain = format!("<{}>", tag);
    let open_attr = format!("<{} ", tag);
    let close = format!("</{}>", tag);
    let mut out = String::with_capacity(html.len());
    let mut pos = 0;
    while pos < html.len() {
        let rest = &html[pos..];
        let hit = match (rest.find(&open_plain), rest.find(&open_attr)) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => break,
        };
        out.push_str(&rest[..hit]);
        match rest[hit..].find(&close) {
            Some(c) => pos += hit + c + close.len(),
            // Unterminated block: drop the tail.
            None => return out,
        }
    }
    out.push_str(&html[pos..]);
    out
}

/// Drop all remaining `<...>` tags, keeping text content.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Scope an HTML document to its `<article>` body when present (ar5iv wraps
/// the paper in one; page chrome like the "improve this article" footer link
/// sits outside and must not pollute text/figure/code-link extraction).
fn article_scope(html: &str) -> &str {
    match (html.find("<article"), html.rfind("</article>")) {
        (Some(a), Some(b)) if b > a => &html[a..b],
        _ => html,
    }
}

/// Convert an HTML document to readable plain text: scopes to `<article>` when
/// present, drops script/style/math/svg blocks, keeps paragraph boundaries,
/// strips tags, unescapes entities.
fn html_to_text(html: &str) -> String {
    let mut s = article_scope(html).to_string();
    for tag in ["script", "style", "noscript", "svg", "math", "head", "nav", "footer"] {
        s = remove_blocks(&s, tag);
    }
    // Preserve block boundaries as newlines before tags are stripped.
    for tag in [
        "</p>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "</li>",
        "</figcaption>", "</section>", "</div>", "</tr>", "</table>", "<br",
    ] {
        s = s.replace(tag, &format!("\n{}", tag));
    }
    let text = xml_unescape(&strip_tags(&s))
        .replace("&nbsp;", " ")
        .replace('\u{a0}', " ");
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let l = collapse_ws(line);
        if l.is_empty() {
            if lines.last().map(|s| !s.is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
        } else {
            lines.push(l);
        }
    }
    lines.join("\n").trim().to_string()
}

/// Extract up to `MAX_FIGURES_PER_PAPER` figures (img URL + caption) from an
/// ar5iv HTML page; relative image paths are resolved against `base`.
fn extract_figures(html: &str, base: &reqwest::Url) -> Vec<LitFigure> {
    let mut out: Vec<LitFigure> = Vec::new();
    for block in xml_blocks(html, "figure") {
        if out.len() >= MAX_FIGURES_PER_PAPER {
            break;
        }
        let Some(img_at) = block.find("<img") else { continue };
        let Some(gt) = block[img_at..].find('>') else { continue };
        let tag = &block[img_at..img_at + gt + 1];
        let Some(src) = xml_attr_value(tag, "src") else { continue };
        let src = src.trim().to_string();
        if src.is_empty() || src.starts_with("data:") {
            continue;
        }
        let Ok(url) = base.join(&src) else { continue };
        let url = url.to_string();
        if out.iter().any(|f| f.url == url) {
            continue;
        }
        let caption = xml_tag_text(block, "figcaption")
            .map(|c| collapse_ws(&xml_unescape(&strip_tags(&c))))
            .unwrap_or_default();
        out.push(LitFigure { url, caption });
    }
    out
}

/// Known code-hosting domains used as "is it open source" evidence.
const CODE_HOSTS: [&str; 5] = [
    "github.com/",
    "gitlab.com/",
    "bitbucket.org/",
    "huggingface.co/",
    "gitee.com/",
];

/// Scan plain text / unescaped HTML for repository links on known code hosts.
fn extract_code_links(hay: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for host in CODE_HOSTS {
        let mut pos = 0;
        while let Some(hit) = hay[pos..].find(host) {
            let start = pos + hit;
            pos = start + host.len();
            // Reject e.g. "mygithub.com/…" (previous char part of a longer name).
            if let Some(prev) = hay[..start].chars().last() {
                if prev.is_ascii_alphanumeric() || prev == '-' {
                    continue;
                }
            }
            let tail = &hay[start..];
            let mut end = tail.len();
            for (i, c) in tail.char_indices() {
                if !(c.is_ascii_alphanumeric() || "-._~/%+#?=&:@".contains(c)) {
                    end = i;
                    break;
                }
            }
            let raw = tail[..end].trim_end_matches(|c: char| "./,;:)]\"'".contains(c));
            // Require a non-empty path after the host (bare domain ≠ repo).
            if raw.len() <= host.len() {
                continue;
            }
            let url = format!("https://{}", raw);
            if !out.contains(&url) {
                out.push(url);
            }
            if out.len() >= MAX_CODE_LINKS_PER_PAPER {
                return out;
            }
        }
    }
    out
}

fn merge_links(into: &mut Vec<String>, add: Vec<String>) {
    for l in add {
        if !into.contains(&l) && into.len() < MAX_CODE_LINKS_PER_PAPER {
            into.push(l);
        }
    }
}

fn fulltext_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(FULLTEXT_FETCH_TIMEOUT_SECS))
        .user_agent("agentboard/0.9 (literature fulltext)")
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {e}"))
}

/// Fetch the ar5iv HTML rendering of an arXiv paper. Returns the raw HTML and
/// the final URL (after redirects) so relative image paths can be resolved.
async fn fetch_arxiv_fulltext(id: &str) -> Option<(String, reqwest::Url)> {
    let client = fulltext_client().ok()?;
    let candidates = [
        format!("https://ar5iv.labs.arxiv.org/html/{id}"),
        format!("https://ar5iv.org/abs/{id}"),
    ];
    for url in candidates {
        let Ok(resp) = client.get(&url).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let final_url = resp.url().clone();
        let Ok(body) = resp.text().await else { continue };
        // ar5iv article pages always carry LaTeXML markers.
        if body.contains("ltx_document") || body.contains("ltx_page_main") {
            return Some((body, final_url));
        }
    }
    None
}

/// Fallback: plain text of the arXiv `/abs/` landing page (abstract, comments
/// — often contains "code available at …" pointers).
async fn fetch_arxiv_abs_text(id: &str) -> Option<String> {
    let client = fulltext_client().ok()?;
    let resp = client
        .get(format!("https://arxiv.org/abs/{id}"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let text = html_to_text(&body);
    if text.is_empty() {
        None
    } else {
        Some(truncate_chars(&text, 6_000))
    }
}

// -- Open-access version resolution (DBLP / OpenAlex → arXiv / ePrint) ------------

/// Extract an arXiv id from an abs/pdf/ar5iv link or an "10.48550/arXiv.…" DOI.
pub(crate) fn arxiv_id_from_link(s: &str) -> Option<String> {
    let s = s.trim();
    for marker in ["arxiv.org/abs/", "arxiv.org/pdf/", "ar5iv.org/abs/", "10.48550/arXiv."] {
        if let Some(at) = s.find(marker) {
            let tail = &s[at + marker.len()..];
            let end = tail
                .find(|c: char| !(c.is_ascii_alphanumeric() || ".-/".contains(c)))
                .unwrap_or(tail.len());
            let id = tail[..end]
                .trim_end_matches(".pdf")
                .trim_matches('/')
                .to_string();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

/// Lowercase alphanumerics only — robust title equality across punctuation,
/// spacing and TeX markup differences.
pub(crate) fn normalize_title(t: &str) -> String {
    t.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Same paper? Exact normalized match, or one is a long prefix of the other
/// (subtitle variants like "…; or: Can ZK be for Free?").
pub(crate) fn titles_match(a: &str, b: &str) -> bool {
    let (na, nb) = (normalize_title(a), normalize_title(b));
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    na == nb
        || (na.len() >= 25 && nb.starts_with(&na))
        || (nb.len() >= 25 && na.starts_with(&nb))
}

/// Find an arXiv version of `title` via a `ti:"…"` query (open-access match).
async fn find_arxiv_id_by_title(title: &str) -> Option<String> {
    let clean = title.replace('"', " ");
    let q = format!("ti:\"{}\"", clean.trim());
    let hits = search_arxiv_raw(&q, 5).await.ok()?;
    hits.into_iter()
        .find(|h| titles_match(&h.title, title))
        .map(|h| h.id)
}

/// Find an IACR ePrint version of `title` via its search page.
async fn find_eprint_id_by_title(title: &str) -> Option<String> {
    let hits = search_eprint(title, 5).await.ok()?;
    hits.into_iter()
        .find(|h| titles_match(&h.title, title))
        .map(|h| h.id)
}

/// Plain text of an ePrint landing page (`https://eprint.iacr.org/YYYY/NNN`) —
/// abstract + keywords + metadata. The PDF body itself is not parsed.
async fn fetch_eprint_page_text(id: &str) -> Option<String> {
    let client = fulltext_client().ok()?;
    let resp = client
        .get(format!("https://eprint.iacr.org/{id}"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let text = html_to_text(&body);
    if text.is_empty() {
        None
    } else {
        Some(truncate_chars(&text, 8_000))
    }
}

/// Try the full arXiv pipeline (ar5iv full text → abs page) for `id`, filling
/// `ex` and returning true on any success. `via` labels the note ("" for
/// native arXiv papers, "arXiv 开放版" when resolved from another source).
async fn fill_from_arxiv(ex: &mut LitPaperExtras, id: &str, open_version: bool) -> bool {
    if let Some((html, final_url)) = fetch_arxiv_fulltext(id).await {
        let body = article_scope(&html);
        ex.figures = extract_figures(body, &final_url);
        merge_links(&mut ex.code_links, extract_code_links(&xml_unescape(body)));
        ex.fulltext = truncate_chars(&html_to_text(&html), FULLTEXT_PER_PAPER_CAP);
        ex.note = if open_version {
            format!("全文（arXiv 开放版 {id}，ar5iv HTML 抓取）")
        } else {
            "全文（ar5iv HTML 抓取）".to_string()
        };
        return true;
    }
    if let Some(text) = fetch_arxiv_abs_text(id).await {
        merge_links(&mut ex.code_links, extract_code_links(&text));
        ex.fulltext = text;
        ex.note = if open_version {
            format!("部分（arXiv 开放版 {id} 摘要页，ar5iv 全文不可用）")
        } else {
            "部分（arXiv 摘要页，ar5iv 全文不可用）".to_string()
        };
        return true;
    }
    false
}

/// Fill `ex` from an ePrint landing page; returns true on success.
async fn fill_from_eprint(ex: &mut LitPaperExtras, id: &str, open_version: bool) -> bool {
    let Some(text) = fetch_eprint_page_text(id).await else {
        return false;
    };
    merge_links(&mut ex.code_links, extract_code_links(&text));
    ex.fulltext = text;
    ex.note = if open_version {
        format!("部分（ePrint 开放版 {id} 摘要页，PDF 正文未解析）")
    } else {
        "部分（ePrint 摘要页，PDF 正文未解析）".to_string()
    };
    true
}

/// Gather full text / figures / code links for one paper. Never fails: on any
/// fetch problem it degrades to abstract/metadata-only and records why in
/// `note`. Only openly available versions are fetched — paywalled bodies never.
async fn fetch_paper_extras(p: &LitPaperInput) -> LitPaperExtras {
    let mut ex = LitPaperExtras {
        title: p.title.clone(),
        ..Default::default()
    };
    merge_links(&mut ex.code_links, extract_code_links(&p.abstract_text));
    let id = p.id.trim();

    // Native arXiv papers: unchanged v0.9 pipeline.
    if p.source == "arxiv" && !id.is_empty() {
        if !fill_from_arxiv(&mut ex, id, false).await {
            ex.note = "仅摘要（全文抓取失败）".to_string();
        }
        return ex;
    }

    // Native ePrint papers: the landing page is the canonical open version.
    if p.source == "eprint" && !id.is_empty() {
        if !fill_from_eprint(&mut ex, id, false).await {
            ex.note = "仅摘要（ePrint 页面抓取失败）".to_string();
        }
        return ex;
    }

    // DBLP / OpenAlex / other: resolve an open version, never the paywall.
    // ① arXiv id already present in the ee/doi link?
    let mut arxiv_id = arxiv_id_from_link(&p.url).or_else(|| arxiv_id_from_link(&p.doi));
    // ② else try an arXiv title match.
    if arxiv_id.is_none() && !p.title.trim().is_empty() {
        arxiv_id = find_arxiv_id_by_title(&p.title).await;
    }
    if let Some(aid) = arxiv_id {
        if fill_from_arxiv(&mut ex, &aid, true).await {
            return ex;
        }
    }
    // ③ else try an IACR ePrint title match.
    if !p.title.trim().is_empty() {
        if let Some(eid) = find_eprint_id_by_title(&p.title).await {
            if fill_from_eprint(&mut ex, &eid, true).await {
                return ex;
            }
        }
    }
    // ④ no open version found: metadata/abstract only, and say so.
    ex.note = if p.abstract_text.trim().is_empty() {
        "仅元数据（未找到开放全文，不抓取付费墙正文）".to_string()
    } else {
        "仅摘要（未找到开放全文，不抓取付费墙正文）".to_string()
    };
    ex
}

// -- Analysis prompt -------------------------------------------------------------

/// System prompt: fixes the per-paper report structure (v0.9 detailed template).
const ANALYSIS_SYSTEM_PROMPT: &str = "你是一名严谨且极其详尽的科研文献分析助手。用户会提供若干篇文献的元信息、摘要，以及（抓取成功时的）正文全文、代码链接与图表标题。请只基于这些材料分析，不要编造材料中不存在的结论；引用具体文献时使用编号（如 [1]）。\n\n输出要求（中文、Markdown）：对每一篇文献，严格按下列结构逐篇输出，充分展开、不要惜字，宁详勿简：\n\n## [编号] 论文标题\n### 一、摘要\n用 2-4 句话说明这篇论文在讲什么。\n### 二、背景知识\n读懂本文所需的前置概念、领域背景与相关工作脉络。\n### 三、Idea Overview\n核心思想与动机：它想解决什么问题、为什么难、解法的直觉是什么。\n### 四、是否开源\n依据提供的「代码链接」字段回答：有链接则逐条列出；没有则明确写「未发现公开代码」。\n### 五、主要方法 / 协议 / 正文要点\n关键方法、协议步骤、技术贡献，分点详细展开（这是报告的重点，务必详细）。\n### 六、实现与效果分析\n实验设置、数据集、评价指标、主要结果数字、与 baseline 的对比、局限性。\n### 七、重要图表\n结合提供的图表标题逐一解释论文关键图/表展示了什么、支撑了什么结论；图片本身由界面另行内联展示，你只负责解读。若未提供图表信息，请基于正文描述关键图表并注明「图表信息未抓取到」。\n\n文献多于一篇时，在逐篇分析之后追加一节「## 横向对比与总结」：比较方法路线、性能、开源情况与适用场景，并指出研究缺口。\n\n注意：「资料级别」标注为「仅摘要」的文献只能基于摘要分析，请在该篇开头注明「（以下分析仅基于摘要，可信度有限）」并适当收敛论断。正文为自动抓取的纯文本，可能残留公式符号与噪声，请自行忽略。";

/// Build the OpenAI messages array for a paper-set analysis. `extras` is the
/// per-paper fetched material aligned by index (missing entries tolerated).
pub(crate) fn build_analysis_messages(
    papers: &[LitPaperInput],
    extras: &[LitPaperExtras],
    instruction: &str,
) -> Vec<Value> {
    // Split the total full-text budget across papers so many selections
    // cannot blow up the prompt.
    let per_fulltext_cap = (FULLTEXT_TOTAL_CAP / papers.len().max(1))
        .clamp(2_000, FULLTEXT_PER_PAPER_CAP);
    let mut ctx = String::new();
    for (i, p) in papers.iter().enumerate() {
        let ex = extras.get(i);
        ctx.push_str(&format!("[{}] {}\n", i + 1, p.title.trim()));
        if !p.authors.is_empty() {
            ctx.push_str(&format!("作者: {}\n", p.authors.join(", ")));
        }
        if !p.year.is_empty() {
            ctx.push_str(&format!("年份: {}\n", p.year));
        }
        if !p.venue.is_empty() {
            ctx.push_str(&format!("发表于: {}\n", p.venue));
        }
        if !p.source.is_empty() {
            ctx.push_str(&format!("来源: {}\n", p.source));
        }
        if !p.url.trim().is_empty() {
            ctx.push_str(&format!("链接: {}\n", p.url.trim()));
        }
        if let Some(ex) = ex {
            if !ex.note.is_empty() {
                ctx.push_str(&format!("资料级别: {}\n", ex.note));
            }
            if ex.code_links.is_empty() {
                ctx.push_str("代码链接: 未发现公开代码链接\n");
            } else {
                ctx.push_str(&format!("代码链接: {}\n", ex.code_links.join(" , ")));
            }
            if !ex.figures.is_empty() {
                ctx.push_str("图表标题:\n");
                for f in &ex.figures {
                    let cap = if f.caption.is_empty() {
                        "（无标题图）".to_string()
                    } else {
                        truncate_chars(&f.caption, 300)
                    };
                    ctx.push_str(&format!("  - {}\n", cap));
                }
            }
        }
        if !p.abstract_text.trim().is_empty() {
            let a: String = p
                .abstract_text
                .trim()
                .chars()
                .take(ABSTRACT_PROMPT_CAP)
                .collect();
            ctx.push_str(&format!("摘要: {}\n", a));
        }
        if let Some(ex) = ex {
            if !ex.fulltext.is_empty() {
                ctx.push_str(&format!(
                    "正文（自动抓取的纯文本，可能含噪声，已截断）:\n{}\n",
                    truncate_chars(&ex.fulltext, per_fulltext_cap)
                ));
            }
        }
        ctx.push('\n');
    }
    vec![
        json!({ "role": "system", "content": ANALYSIS_SYSTEM_PROMPT }),
        json!({
            "role": "user",
            "content": format!("以下是 {} 篇文献：\n\n{}分析要求：{}", papers.len(), ctx, instruction)
        }),
    ]
}

// -- Tauri commands ----------------------------------------------------------------

/// Search a free literature source.
/// `source`: "arxiv" (default) | "openalex" | "dblp" | "eprint".
/// `venues` (DBLP only): whitelist keys like "crypto"/"sp"/…; empty/None = all nine.
#[tauri::command]
pub(crate) async fn lit_search(
    query: String,
    source: Option<String>,
    limit: Option<u32>,
    venues: Option<Vec<String>>,
) -> Result<Vec<LitPaper>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("请输入搜索关键词".to_string());
    }
    let limit = limit.unwrap_or(10).clamp(1, 50);
    match source.as_deref().unwrap_or("arxiv") {
        "openalex" => search_openalex(q, limit).await,
        "dblp" => search_dblp(q, &venues.unwrap_or_default(), limit).await,
        "eprint" => search_eprint(q, limit).await,
        _ => search_arxiv(q, limit).await,
    }
}

/// Analyze checked papers via the existing relay chat path. First fetches the
/// full text / figures / code links per paper (concurrently, fault-tolerant),
/// then returns the Markdown report plus the per-paper extras in one shot.
#[tauri::command]
pub(crate) async fn lit_analyze(
    papers: Vec<LitPaperInput>,
    instruction: Option<String>,
    model: String,
    provider_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<LitAnalyzeResult, String> {
    if papers.is_empty() {
        return Err("请先勾选至少一篇文献".to_string());
    }
    if model.trim().is_empty() {
        return Err("未指定分析模型（请先在设置中添加聊天服务商）".to_string());
    }
    let instr = instruction
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_INSTRUCTION.to_string());
    let extras: Vec<LitPaperExtras> =
        futures_util::future::join_all(papers.iter().map(fetch_paper_extras)).await;
    let messages = build_analysis_messages(&papers, &extras, &instr);
    let creds = crate::providers::resolve_creds(&state.db, provider_id.as_deref())?;
    let outcome = crate::relay::chat_stream(
        &creds,
        model.trim(),
        messages,
        CancellationToken::new(),
        |_delta| {},
    )
    .await?;
    if outcome.text.trim().is_empty() {
        return Err("模型未返回分析内容".to_string());
    }
    Ok(LitAnalyzeResult {
        analysis: outcome.text,
        papers: extras,
    })
}

// -- Unit tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const ARXIV_SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=all:ckks</title>
  <entry>
    <id>http://arxiv.org/abs/2101.00001v2</id>
    <updated>2021-02-01T00:00:00Z</updated>
    <published>2021-01-05T10:00:00Z</published>
    <title>Faster CKKS Bootstrapping:
  A &amp; B Approach</title>
    <summary>  We present a faster bootstrapping
  method for CKKS with &lt;small&gt; error.  </summary>
    <author><name>Alice Zhang</name></author>
    <author><name>Bob Li</name></author>
    <link href="http://arxiv.org/abs/2101.00001v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2101.00001v2" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2202.12345v1</id>
    <published>2022-06-30T00:00:00Z</published>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <author><name>Carol Wu</name></author>
  </entry>
</feed>"#;

    #[test]
    fn arxiv_atom_parses_entries() {
        let papers = parse_arxiv_atom(ARXIV_SAMPLE);
        assert_eq!(papers.len(), 2);

        let p = &papers[0];
        assert_eq!(p.id, "2101.00001v2");
        assert_eq!(p.title, "Faster CKKS Bootstrapping: A & B Approach");
        assert_eq!(p.authors, vec!["Alice Zhang", "Bob Li"]);
        assert_eq!(p.year, "2021");
        assert_eq!(
            p.abstract_text,
            "We present a faster bootstrapping method for CKKS with <small> error."
        );
        assert_eq!(p.url, "http://arxiv.org/pdf/2101.00001v2");
        assert_eq!(p.source, "arxiv");

        let q = &papers[1];
        assert_eq!(q.id, "2202.12345v1");
        assert_eq!(q.year, "2022");
        // No pdf link: falls back to the abs page.
        assert_eq!(q.url, "http://arxiv.org/abs/2202.12345v1");
    }

    #[test]
    fn arxiv_atom_ignores_feed_level_title() {
        // The feed-level <title> must not leak in as a paper (it sits outside
        // any <entry> block).
        let papers = parse_arxiv_atom(ARXIV_SAMPLE);
        assert!(papers.iter().all(|p| !p.title.contains("ArXiv Query")));
    }

    #[test]
    fn xml_unescape_handles_entities() {
        assert_eq!(
            xml_unescape("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"),
            "a & b <c> \"d\" 'e'"
        );
    }

    const OPENALEX_SAMPLE: &str = r#"{
      "results": [
        {
          "id": "https://openalex.org/W123",
          "display_name": "Homomorphic Encryption Survey",
          "publication_year": 2023,
          "doi": "https://doi.org/10.1000/xyz",
          "authorships": [
            {"author": {"display_name": "Dana Kim"}},
            {"author": {"display_name": "Evan Ortiz"}}
          ],
          "abstract_inverted_index": {
            "survey": [3],
            "A": [0],
            "complete": [1, 2]
          }
        },
        {
          "id": "https://openalex.org/W456",
          "title": "No Abstract Work",
          "publication_year": 2020,
          "primary_location": {"landing_page_url": "https://example.org/p"},
          "authorships": []
        }
      ]
    }"#;

    #[test]
    fn openalex_parses_and_reconstructs_abstract() {
        let papers = parse_openalex_json(OPENALEX_SAMPLE).unwrap();
        assert_eq!(papers.len(), 2);

        let p = &papers[0];
        assert_eq!(p.id, "W123");
        assert_eq!(p.title, "Homomorphic Encryption Survey");
        assert_eq!(p.year, "2023");
        assert_eq!(p.authors, vec!["Dana Kim", "Evan Ortiz"]);
        assert_eq!(p.abstract_text, "A complete complete survey");
        assert_eq!(p.url, "https://doi.org/10.1000/xyz");
        assert_eq!(p.source, "openalex");

        let q = &papers[1];
        assert_eq!(q.title, "No Abstract Work");
        assert_eq!(q.abstract_text, "");
        // No DOI: landing page url fallback.
        assert_eq!(q.url, "https://example.org/p");
    }

    #[test]
    fn openalex_rejects_bodies_without_results() {
        assert!(parse_openalex_json("{}").is_err());
        assert!(parse_openalex_json("not json").is_err());
    }

    #[test]
    fn analysis_messages_include_papers_and_instruction() {
        let papers = vec![
            LitPaperInput {
                title: "Paper One".to_string(),
                authors: vec!["A".to_string(), "B".to_string()],
                year: "2021".to_string(),
                abstract_text: "First abstract.".to_string(),
                source: "arxiv".to_string(),
                ..Default::default()
            },
            LitPaperInput {
                title: "Paper Two".to_string(),
                ..Default::default()
            },
        ];
        let msgs = build_analysis_messages(&papers, &[], DEFAULT_INSTRUCTION);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        let system = msgs[0]["content"].as_str().unwrap();
        // The detailed per-paper template must be pinned in the system prompt.
        for marker in ["一、摘要", "四、是否开源", "七、重要图表", "横向对比与总结"] {
            assert!(system.contains(marker), "missing template section: {marker}");
        }
        let user = msgs[1]["content"].as_str().unwrap();
        assert!(user.contains("[1] Paper One"));
        assert!(user.contains("作者: A, B"));
        assert!(user.contains("First abstract."));
        assert!(user.contains("[2] Paper Two"));
        assert!(user.contains("2 篇文献"));
        assert!(user.contains(DEFAULT_INSTRUCTION));
    }

    #[test]
    fn analysis_messages_include_fetched_extras() {
        let papers = vec![LitPaperInput {
            title: "Deep Paper".to_string(),
            url: "https://arxiv.org/abs/2101.00001".to_string(),
            source: "arxiv".to_string(),
            ..Default::default()
        }];
        let extras = vec![LitPaperExtras {
            title: "Deep Paper".to_string(),
            note: "全文（ar5iv HTML 抓取）".to_string(),
            code_links: vec!["https://github.com/foo/bar".to_string()],
            figures: vec![LitFigure {
                url: "https://ar5iv.labs.arxiv.org/html/2101.00001/x1.png".to_string(),
                caption: "Figure 1: Architecture overview.".to_string(),
            }],
            fulltext: "Introduction. We propose a method.".to_string(),
        }];
        let msgs = build_analysis_messages(&papers, &extras, "分析");
        let user = msgs[1]["content"].as_str().unwrap();
        assert!(user.contains("资料级别: 全文（ar5iv HTML 抓取）"));
        assert!(user.contains("代码链接: https://github.com/foo/bar"));
        assert!(user.contains("Figure 1: Architecture overview."));
        assert!(user.contains("链接: https://arxiv.org/abs/2101.00001"));
        assert!(user.contains("We propose a method."));
    }

    #[test]
    fn analysis_messages_note_missing_code_links() {
        let papers = vec![LitPaperInput {
            title: "P".to_string(),
            ..Default::default()
        }];
        let extras = vec![LitPaperExtras {
            title: "P".to_string(),
            note: "仅摘要（全文抓取失败）".to_string(),
            ..Default::default()
        }];
        let msgs = build_analysis_messages(&papers, &extras, "分析");
        let user = msgs[1]["content"].as_str().unwrap();
        assert!(user.contains("代码链接: 未发现公开代码链接"));
        assert!(user.contains("资料级别: 仅摘要（全文抓取失败）"));
    }

    #[test]
    fn analysis_messages_cap_long_abstracts() {
        let long = "x".repeat(ABSTRACT_PROMPT_CAP + 500);
        let papers = vec![LitPaperInput {
            title: "Long".to_string(),
            abstract_text: long,
            ..Default::default()
        }];
        let msgs = build_analysis_messages(&papers, &[], "对比");
        let user = msgs[1]["content"].as_str().unwrap();
        let x_run = user.chars().filter(|&c| c == 'x').count();
        assert_eq!(x_run, ABSTRACT_PROMPT_CAP);
    }

    #[test]
    fn analysis_messages_split_fulltext_budget() {
        // 4 papers with huge fulltexts: each must be capped to the shared
        // budget (60k/4 = 15k), not the per-paper 20k cap.
        let papers: Vec<LitPaperInput> = (0..4)
            .map(|i| LitPaperInput {
                title: format!("P{i}"),
                ..Default::default()
            })
            .collect();
        let extras: Vec<LitPaperExtras> = (0..4)
            .map(|i| LitPaperExtras {
                title: format!("P{i}"),
                fulltext: "y".repeat(FULLTEXT_PER_PAPER_CAP),
                ..Default::default()
            })
            .collect();
        let msgs = build_analysis_messages(&papers, &extras, "分析");
        let user = msgs[1]["content"].as_str().unwrap();
        let y_total = user.chars().filter(|&c| c == 'y').count();
        assert_eq!(y_total, 4 * (FULLTEXT_TOTAL_CAP / 4));
    }

    #[test]
    fn html_to_text_strips_markup_and_keeps_paragraphs() {
        let html = r#"<html><head><title>skip me</title><style>.x{}</style></head>
<body><article class="ltx_document">
<script>var x=1;</script>
<h1 class="ltx_title">A &amp; B</h1>
<p class="ltx_p">First   paragraph with <em>emphasis</em>.</p>
<math><mi>x</mi></math>
<p class="ltx_p">Second paragraph.</p>
</article></body></html>"#;
        let text = html_to_text(html);
        assert!(text.contains("A & B"));
        assert!(text.contains("First paragraph with emphasis."));
        assert!(text.contains("Second paragraph."));
        assert!(!text.contains("skip me"));
        assert!(!text.contains("var x=1"));
        assert!(!text.contains("<p"));
        // Math blocks are dropped entirely.
        assert!(!text.contains("mi"));
    }

    #[test]
    fn extract_figures_resolves_urls_and_captions() {
        let base = reqwest::Url::parse("https://ar5iv.labs.arxiv.org/html/2101.00001").unwrap();
        let html = r#"
<figure id="S1.F1" class="ltx_figure">
  <img src="/html/2101.00001/assets/x1.png" class="ltx_graphics"/>
  <figcaption class="ltx_caption"><span class="ltx_tag">Figure 1: </span>System &amp; overview.</figcaption>
</figure>
<figure class="ltx_figure"><img src="x2.png"></figure>
<figure class="ltx_figure"><img src="data:image/png;base64,AAAA"></figure>"#;
        let figs = extract_figures(html, &base);
        assert_eq!(figs.len(), 2);
        assert_eq!(
            figs[0].url,
            "https://ar5iv.labs.arxiv.org/html/2101.00001/assets/x1.png"
        );
        assert_eq!(figs[0].caption, "Figure 1: System & overview.");
        // Relative path resolves against the page URL's directory.
        assert_eq!(figs[1].url, "https://ar5iv.labs.arxiv.org/html/x2.png");
    }

    #[test]
    fn extract_code_links_finds_and_filters() {
        let text = "Code at https://github.com/foo/bar. Also see github.com/foo/bar \
and (https://gitlab.com/a/b), but not mygithub.com/x/y or the bare github.com/ domain. \
Model: https://huggingface.co/org/model-1.5";
        let links = extract_code_links(text);
        assert_eq!(
            links,
            vec![
                "https://github.com/foo/bar".to_string(),
                "https://gitlab.com/a/b".to_string(),
                "https://huggingface.co/org/model-1.5".to_string(),
            ]
        );
    }

    #[test]
    fn code_link_extraction_ignores_page_chrome_outside_article() {
        let html = r#"<body><article class="ltx_document">
<p>Code: <a href="https://github.com/real/repo">repo</a></p>
</article>
<footer><a href="https://github.com/dginev/ar5iv/issues/new?title=Improve">Improve article</a></footer>
</body>"#;
        let links = extract_code_links(&xml_unescape(article_scope(html)));
        assert_eq!(links, vec!["https://github.com/real/repo".to_string()]);
    }

    // -- DBLP ---------------------------------------------------------------

    const DBLP_SAMPLE: &str = r#"{
      "result": {
        "hits": {
          "@total": "3", "@sent": "3",
          "hit": [
            {
              "@id": "1",
              "info": {
                "authors": {"author": [
                  {"@pid": "c/RC", "text": "Ronald Cramer"},
                  {"@pid": "d/ID", "text": "Ivan Damgård"}
                ]},
                "title": "Zero-Knowledge Proofs for Finite Field Arithmetic.",
                "venue": "CRYPTO", "year": "1998",
                "key": "conf/crypto/CramerD98",
                "doi": "10.1007/BFB0055745",
                "ee": "https://doi.org/10.1007/BFb0055745",
                "url": "https://dblp.org/rec/conf/crypto/CramerD98"
              }
            },
            {
              "@id": "2",
              "info": {
                "authors": {"author": {"@pid": "x/Solo", "text": "Solo Author"}},
                "title": "A TIFS Journal Paper",
                "venue": "IEEE Trans. Inf. Forensics Secur.", "year": "2024",
                "key": "journals/tifs/Solo24",
                "ee": "https://arxiv.org/abs/2401.01234",
                "url": "https://dblp.org/rec/journals/tifs/Solo24"
              }
            },
            {
              "@id": "3",
              "info": {
                "title": "Off-Whitelist Paper",
                "venue": "ICML", "year": "2024",
                "key": "conf/icml/Nope24",
                "url": "https://dblp.org/rec/conf/icml/Nope24"
              }
            }
          ]
        }
      }
    }"#;

    #[test]
    fn dblp_parses_and_filters_venue_whitelist() {
        let papers = parse_dblp_json(DBLP_SAMPLE).unwrap();
        // The ICML hit is outside the nine-venue whitelist and must be dropped.
        assert_eq!(papers.len(), 2);

        let p = &papers[0];
        assert_eq!(p.id, "conf/crypto/CramerD98");
        // Trailing period stripped.
        assert_eq!(p.title, "Zero-Knowledge Proofs for Finite Field Arithmetic");
        assert_eq!(p.authors, vec!["Ronald Cramer", "Ivan Damgård"]);
        assert_eq!(p.year, "1998");
        assert_eq!(p.venue, "CRYPTO");
        assert_eq!(p.doi, "10.1007/BFB0055745");
        assert_eq!(p.url, "https://doi.org/10.1007/BFb0055745");
        assert_eq!(p.source, "dblp");
        assert_eq!(p.abstract_text, "");

        // Single-author object (not array) still parses; venue label mapped.
        let q = &papers[1];
        assert_eq!(q.authors, vec!["Solo Author"]);
        assert_eq!(q.venue, "IEEE TIFS");
        assert_eq!(q.url, "https://arxiv.org/abs/2401.01234");
    }

    #[test]
    fn dblp_tolerates_empty_hits() {
        let empty = r#"{"result":{"hits":{"@total":"0"}}}"#;
        assert!(parse_dblp_json(empty).unwrap().is_empty());
        assert!(parse_dblp_json("{}").is_err());
    }

    #[test]
    fn dblp_venue_key_prefix_must_be_exact_segment() {
        // "conf/ccs2" must not match the "conf/ccs" stream.
        assert!(venue_of_dblp_key("conf/ccs/Abc24").is_some());
        assert!(venue_of_dblp_key("conf/ccs2/Abc24").is_none());
        assert!(venue_of_dblp_key("conf/sp/Xyz23").is_some());
        assert!(venue_of_dblp_key("journals/tdsc/Foo22").is_some());
        assert!(venue_of_dblp_key("conf/icml/Nope24").is_none());
    }

    #[test]
    fn dedup_recent_first_sorts_and_caps() {
        let mk = |id: &str, year: &str| LitPaper {
            id: id.to_string(),
            title: id.to_string(),
            authors: vec![],
            year: year.to_string(),
            abstract_text: String::new(),
            url: String::new(),
            source: "dblp".to_string(),
            venue: String::new(),
            doi: String::new(),
        };
        let v = vec![mk("a", "1998"), mk("b", "2024"), mk("a", "1998"), mk("c", "2020")];
        let out = dedup_recent_first(v, 2);
        assert_eq!(
            out.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["b", "c"]
        );
    }

    // -- IACR ePrint ----------------------------------------------------------

    const EPRINT_SAMPLE: &str = r#"
      <div class="mb-4">
        <div class="d-flex"><a title="2026/1366" class="paperlink" href="/2026/1366">2026/1366</a>
          <span class="ms-2"><a href="/2026/1366.pdf">(PDF)</a></span>
          <small class="ms-auto">Last updated: 2026-07-02</small>
        </div>
        <div class="ms-md-4">
          <strong>Halfspace Learning for <mark>Lattice</mark> Signature Key Recovery</strong>
          <div class="mt-1"><span class="fst-italic">Marcus Brinkmann, Nicolai Kraus, Alexander May</span></div>
          <p class="mb-0 mt-1 search-abstract">Any signature scheme has to protect its
secret key &amp; randomness.</p>
        </div>
      </div>
      <div class="mb-4">
        <div class="d-flex"><a title="2025/0042" class="paperlink" href="/2025/0042">2025/0042</a></div>
        <div class="ms-md-4"><strong>Minimal Entry</strong></div>
      </div>"#;

    #[test]
    fn eprint_html_parses_entries() {
        let papers = parse_eprint_html(EPRINT_SAMPLE);
        assert_eq!(papers.len(), 2);

        let p = &papers[0];
        assert_eq!(p.id, "2026/1366");
        assert_eq!(p.year, "2026");
        // <mark> highlight stripped.
        assert_eq!(
            p.title,
            "Halfspace Learning for Lattice Signature Key Recovery"
        );
        assert_eq!(
            p.authors,
            vec!["Marcus Brinkmann", "Nicolai Kraus", "Alexander May"]
        );
        assert_eq!(
            p.abstract_text,
            "Any signature scheme has to protect its secret key & randomness."
        );
        assert_eq!(p.url, "https://eprint.iacr.org/2026/1366");
        assert_eq!(p.source, "eprint");

        // Entry without authors/abstract still yields a paper.
        let q = &papers[1];
        assert_eq!(q.id, "2025/0042");
        assert_eq!(q.title, "Minimal Entry");
        assert!(q.authors.is_empty());
        assert_eq!(q.abstract_text, "");
    }

    #[test]
    fn eprint_html_ignores_garbage() {
        assert!(parse_eprint_html("").is_empty());
        assert!(parse_eprint_html("<html><body>no results</body></html>").is_empty());
    }

    // -- Open-version resolution ----------------------------------------------

    #[test]
    fn arxiv_id_from_link_variants() {
        assert_eq!(
            arxiv_id_from_link("https://arxiv.org/abs/2401.01234v2"),
            Some("2401.01234v2".to_string())
        );
        assert_eq!(
            arxiv_id_from_link("http://arxiv.org/pdf/2401.01234.pdf"),
            Some("2401.01234".to_string())
        );
        assert_eq!(
            arxiv_id_from_link("10.48550/arXiv.2301.00001"),
            Some("2301.00001".to_string())
        );
        assert_eq!(arxiv_id_from_link("https://doi.org/10.1007/xyz"), None);
        assert_eq!(arxiv_id_from_link(""), None);
    }

    #[test]
    fn titles_match_is_robust_to_punctuation() {
        assert!(titles_match(
            "Zero-Knowledge Proofs for Finite Field Arithmetic",
            "zero knowledge proofs for finite field arithmetic."
        ));
        // Long-prefix subtitle variant.
        assert!(titles_match(
            "Zero-Knowledge Proofs for Finite Field Arithmetic",
            "Zero-Knowledge Proofs for Finite Field Arithmetic; or: Can Zero-Knowledge be for Free?"
        ));
        assert!(!titles_match("Attention Is All You Need", "Attention"));
        assert!(!titles_match("", "x"));
    }

    #[test]
    fn truncate_chars_marks_truncation() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        let t = truncate_chars(&"z".repeat(10), 4);
        assert!(t.starts_with("zzzz"));
        assert!(t.contains("已截断"));
    }

    // -- Live test (network; run with: cargo test -- --ignored --nocapture) ------

    #[tokio::test]
    #[ignore]
    async fn live_fetch_paper_extras_arxiv() {
        let p = LitPaperInput {
            title: "Attention Is All You Need".to_string(),
            id: "1706.03762".to_string(),
            source: "arxiv".to_string(),
            ..Default::default()
        };
        let ex = fetch_paper_extras(&p).await;
        println!("note: {}", ex.note);
        println!("fulltext chars: {}", ex.fulltext.chars().count());
        println!("code links: {:?}", ex.code_links);
        for f in &ex.figures {
            println!("figure: {} | {}", f.url, truncate_chars(&f.caption, 100));
        }
        assert!(
            ex.note.starts_with("全文") || ex.note.starts_with("部分"),
            "expected fulltext or abs-page fetch, got: {}",
            ex.note
        );
        assert!(!ex.fulltext.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn live_dblp_search() {
        // Venue-scoped: keyword hits inside CRYPTO only.
        let papers = search_dblp("zero-knowledge", &["crypto".to_string()], 5)
            .await
            .expect("DBLP search should succeed");
        assert!(!papers.is_empty(), "expected at least one DBLP hit");
        for p in &papers {
            println!("[{}] {} ({} {}) {}", p.id, p.title, p.venue, p.year, p.url);
            assert_eq!(p.venue, "CRYPTO");
            assert!(p.id.starts_with("conf/crypto/"));
        }
        // All-venue merge, newest first.
        let all = search_dblp("fuzzing", &[], 10).await.expect("all-venue DBLP");
        assert!(!all.is_empty());
        for p in &all {
            println!("[{}] {} ({} {})", p.id, p.title, p.venue, p.year);
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_eprint_search() {
        let papers = search_eprint("lattice signature", 5)
            .await
            .expect("ePrint search should succeed");
        assert!(!papers.is_empty(), "expected at least one ePrint hit");
        for p in &papers {
            println!("[{}] {} ({}) {}", p.id, p.title, p.year, p.url);
            assert!(p.url.starts_with("https://eprint.iacr.org/"));
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_open_version_resolution_for_dblp_paper() {
        // A TIFS paper whose ee is paywalled but which has an arXiv version.
        let p = LitPaperInput {
            title: "Attention Is All You Need".to_string(),
            id: "conf/nips/VaswaniSPUJGKP17".to_string(),
            url: "https://doi.org/10.5555/3295222".to_string(),
            source: "dblp".to_string(),
            ..Default::default()
        };
        let ex = fetch_paper_extras(&p).await;
        println!("note: {}", ex.note);
        println!("fulltext chars: {}", ex.fulltext.chars().count());
        assert!(
            ex.note.contains("开放版") || ex.note.contains("未找到开放全文"),
            "unexpected note: {}",
            ex.note
        );
    }

    #[tokio::test]
    #[ignore]
    async fn live_arxiv_search() {
        let papers = search_arxiv("homomorphic encryption", 3)
            .await
            .expect("arXiv search should succeed");
        assert!(!papers.is_empty(), "expected at least one arXiv hit");
        for p in &papers {
            println!("[{}] {} ({}) {}", p.id, p.title, p.year, p.url);
            assert!(!p.title.is_empty());
        }
    }
}
